"""Step 10: train the discovery prior, P(venue hosts private events).

    python3 ml/train_discovery.py

Two variants: pre_fetch (Google fields + name; used to order candidates before
any page is read) and post_fetch (adds has_external_event_link from the
homepage). Same grouped CV and C grid as the confidence model. Compares
against the v0 hand-set prior (column v0_prior, computed in TypeScript) and
random order, including yield@K: the share of the top-K venues that host
private events. Exports src/data/discovery-prior.json.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import numpy as np  # noqa: E402

from ml.common import (  # noqa: E402
    model_dir,
    SEED,
    RunManifest,
    assert_no_leakage,
    build_pipeline,
    columns_between,
    eval_dir,
    export_logistic,
    git_sha,
    gold_ids,
    group_folds,
    load_table,
    metrics_with_ci,
    model_version,
    reliability_diagram,
    score_exported,
    select_C,
    sha256_file,
    test_subsets,
    write_json,
    write_parity,
)

SCALE_COLS = ["price_level", "rating", "log_reviews"]
POST_ONLY = "has_external_event_link"
REFERENCE_BUCKET = "casual_restaurant"
KS = [10, 25]
MIN_MINORITY_TRAIN = 15
RANDOM_SHUFFLES = 1000


def yield_at_k(y, score, k: int) -> float | None:
    """Share of the top-k venues by score that host private events (ties broken by row order)."""
    y = np.asarray(y, dtype=float)
    if len(y) == 0:
        return None
    order = np.argsort(-np.asarray(score, dtype=float), kind="stable")
    return float(y[order[: min(k, len(y))]].mean())


def random_yield(y, k: int, seed: int = SEED) -> float | None:
    y = np.asarray(y, dtype=float)
    if len(y) == 0:
        return None
    rng = np.random.default_rng(seed)
    kk = min(k, len(y))
    return float(np.mean([y[rng.permutation(len(y))[:kk]].mean() for _ in range(RANDOM_SHUFFLES)]))


def ranking_report(y, scores: dict) -> dict:
    out = {}
    for k in KS:
        row = {name: yield_at_k(y, s, k) for name, s in scores.items()}
        row["random"] = random_yield(y, k)
        row["k_used"] = int(min(k, len(y)))
        out[f"yield@{k}"] = row
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--bootstrap", type=int, default=1000)
    ap.add_argument("--no-export", action="store_true")
    args = ap.parse_args()

    manifest = RunManifest("ml/train_discovery.py")
    train = load_table("train_discovery.csv")
    test = load_table("test_discovery.csv")
    assert_no_leakage(train, test, gold_ids())
    manifest.inputs += [eval_dir("train_discovery.csv"), eval_dir("test_discovery.csv")]

    post = columns_between(train, "y", "v0_prior")
    if post[-1] != POST_ONLY:
        raise SystemExit(f"expected {POST_ONLY} last among the discovery columns, got {post[-1]}")
    variants = {"pre_fetch": post[:-1], "post_fetch": post}
    bucket_order = [c[len("bucket_"):] for c in post if c.startswith("bucket_")]

    y = train["y"].astype(int).to_numpy()
    groups = train["domain"].to_numpy()
    pos = int(y.sum())
    minority = min(pos, len(y) - pos)
    report: dict = {"rows": {"train": len(train), "test": len(test), "train_positives": pos, "minority": minority}}
    print(f"train venues {len(train)} (host events {pos}); test venues {len(test)}")

    v0_sets = {"oof": metrics_with_ci(y, train["v0_prior"], groups, args.bootstrap)}
    for name, sub in test_subsets(test).items():
        v0_sets[name] = metrics_with_ci(sub["y"], sub["v0_prior"], sub["domain"], args.bootstrap) if len(sub) else {"n": 0}
    report["baseline_v0_prior"] = v0_sets

    if minority < MIN_MINORITY_TRAIN:
        report["decision"] = f"Not trained: minority class has {minority} venues (< {MIN_MINORITY_TRAIN}); the app keeps the v0 prior."
        print(report["decision"])
        write_json(eval_dir("results", "discovery_model.json"), report)
        manifest.notes = report["decision"]
        manifest.write("skipped")
        return 0

    folds = group_folds(y, groups)
    exported_variants, results = {}, {}
    curves = {}
    for name, features in variants.items():
        X = train[features].astype(float).to_numpy()
        C, scores, oof_p = select_C(X, y, folds, features, SCALE_COLS)
        pipe = build_pipeline(features, SCALE_COLS, C).fit(X, y)
        exp = export_logistic(pipe, features, SCALE_COLS)

        def predict(d, pipe=pipe, features=features):
            return pipe.predict_proba(d[features].astype(float).to_numpy())[:, 1]

        if len(test):
            gap = float(np.max(np.abs(score_exported(exp, test[features].astype(float).to_numpy()) - predict(test))))
            if gap > 1e-9:
                raise SystemExit(f"{name}: exported model disagrees with scikit-learn by {gap}")
        frame = test if len(test) else train
        write_parity(f"discovery_{name}", exp, frame, features, predict(frame))
        sets = {"oof": metrics_with_ci(y, oof_p, groups, args.bootstrap)}
        for sname, sub in test_subsets(test).items():
            sets[sname] = metrics_with_ci(sub["y"], predict(sub), sub["domain"], args.bootstrap) if len(sub) else {"n": 0}
        sets["test_all"] = metrics_with_ci(test["y"], predict(test), test["domain"], 0) if len(test) else {"n": 0}
        rank = {
            "oof": ranking_report(y, {"model": oof_p, "v0_prior": train["v0_prior"].to_numpy(float)}),
            "test_all": ranking_report(
                test["y"].to_numpy(), {"model": predict(test), "v0_prior": test["v0_prior"].to_numpy(float)}
            )
            if len(test)
            else {},
        }
        results[name] = {
            "C": C,
            "oof_log_loss_by_C": {str(k): v for k, v in scores.items()},
            "metrics": sets,
            "ranking": rank,
            "coefficients": [{"feature": f, "coef": c, "odds_ratio": float(np.exp(c))} for f, c in zip(features, exp["coef"])],
        }
        exported_variants[name] = {**exp, "metrics": {k: {m: v for m, v in s.items() if m != "ci95"} for k, s in sets.items()}}
        curves[f"{name}, out of fold"] = (y, oof_p)
        if len(test):
            curves[f"{name}, test"] = (test["y"], predict(test))
        print(f"  {name}: C={C}  OOF AUC {sets['oof']['auc']}  log loss {sets['oof']['log_loss']:.3f}")
    curves["v0 prior, out of fold"] = (y, train["v0_prior"].to_numpy(float))
    reliability_diagram(curves, eval_dir("results", "discovery_reliability.png"), "Discovery prior")
    report["variants"] = results

    model = {
        "model": "discovery_prior",
        "version": model_version(),
        "reference_bucket": REFERENCE_BUCKET,
        "bucket_order": bucket_order,
        "variants": exported_variants,
        "trained_on": {
            "rows": int(len(y)),
            "positives": pos,
            "label_sources": {k: int(v) for k, v in train["label_source"].value_counts().items()},
        },
        "data_sha256": sha256_file(eval_dir("train_discovery.csv")),
        "git_sha": git_sha(),
        "seed": SEED,
    }
    write_json(eval_dir("results", "discovery_model.json"), report)
    out = model_dir() / "discovery-prior.json"
    if not args.no_export:
        write_json(out, model)
        manifest.outputs.append(out)
    manifest.outputs += [eval_dir("results", "discovery_model.json")]
    manifest.models["discovery_prior"] = model["version"]
    manifest.counts.update({"train_rows": len(y), "positives": pos, "test_rows": len(test)})
    manifest.write()
    return 0


if __name__ == "__main__":
    sys.exit(main())
