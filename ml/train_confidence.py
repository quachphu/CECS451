"""Step 9: train the room-capacity confidence model.

    python3 ml/train_confidence.py

Reads eval/train_confidence.csv and eval/test_confidence.csv (written by
scripts/data/08_build_tables.ts; Python never recomputes features). Picks C by
grouped out-of-fold log loss on the train set only, compares against three
baselines (B0 v0 trust weights, B1 evidence lookup, B2 constant), and exports
src/data/confidence-model.json plus eval/results/confidence_*.{json,png}.
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
    gold_ids,
    group_folds,
    load_table,
    metrics_with_ci,
    model_version,
    odds_sentence,
    oof_predict,
    reliability_diagram,
    score_exported,
    select_C,
    sha256_file,
    test_subsets,
    write_json,
    git_sha,
    write_parity,
)

SCALE_COLS = ["self_consistency", "competing_numbers"]
FALLBACK_FEATURES = ["grounded", "self_consistency", "regex_agree"]
MIN_MINORITY_FULL = 30  # below this, 3 features [P10]
MIN_MINORITY_TRAIN = 15  # below this, don't train
IMBALANCE_SHARE = 0.15
SENSITIVITY = [0.05, 0.20]
EXPECTED_FEATURES = [
    "self_consistency",
    "regex_agree",
    "regex_absent",
    "grounded",
    "competing_numbers",
    "private_page_found",
]


# ---------------------------------------------------------------- baselines

def regex_status(df) -> np.ndarray:
    return np.where(df["regex_agree"] == 1, "agree", np.where(df["regex_absent"] == 1, "absent", "disagree"))


class EvidenceLookup:
    """B1: empirical accuracy per (grounded, regex_status), Laplace-smoothed: (pos + 1) / (n + 2)."""

    def fit(self, df, y):
        keys = list(zip(df["grounded"].astype(int), regex_status(df)))
        self.table = {}
        for k in set(keys):
            m = np.array([kk == k for kk in keys])
            self.table[k] = (y[m].sum() + 1) / (m.sum() + 2)
        self.default = (y.sum() + 1) / (len(y) + 2)
        return self

    def predict(self, df) -> np.ndarray:
        keys = zip(df["grounded"].astype(int), regex_status(df))
        return np.array([self.table.get(k, self.default) for k in keys], dtype=float)


def oof_baseline(fit_predict, df, y, folds) -> np.ndarray:
    out = np.zeros(len(y))
    for tr, te in folds:
        out[te] = fit_predict(df.iloc[tr], y[tr], df.iloc[te])
    return out


def b1(train_df, y, test_df):
    return EvidenceLookup().fit(train_df, y).predict(test_df)


def b2(train_df, y, test_df):
    return np.full(len(test_df), float(y.mean()))


# ------------------------------------------------------------- calibration

def calibrated_balanced(features, C, X, y, groups):
    """Balanced weights, then one sigmoid recalibration fitted on grouped out-of-fold decision values [D8].
    ensemble=False keeps a single (model, sigmoid) pair so a and b can be exported."""
    from sklearn.calibration import CalibratedClassifierCV

    folds = group_folds(y, groups)
    cal = CalibratedClassifierCV(
        build_pipeline(features, SCALE_COLS, C, class_weight="balanced"), method="sigmoid", cv=folds, ensemble=False
    )
    cal.fit(X, y)
    return cal


def sigmoid_params(cal) -> dict:
    calibrator = cal.calibrated_classifiers_[0].calibrators[0]
    return {"a": float(calibrator.a_), "b": float(calibrator.b_)}


# -------------------------------------------------------------------- main

def matrix(df, features) -> np.ndarray:
    return df[features].astype(float).to_numpy()


def labels_at(df, threshold: float) -> np.ndarray:
    err = df["abs_rel_error"].astype(float)
    return ((~err.isna()) & (err <= threshold + 1e-12)).astype(int).to_numpy()


def evaluate_sets(predict, train, oof_p, test, n_boot) -> dict:
    out = {"oof": metrics_with_ci(train["y"], oof_p, train["domain"], n_boot)}
    for name, sub in test_subsets(test).items():
        out[name] = metrics_with_ci(sub["y"], predict(sub), sub["domain"], n_boot) if len(sub) else {"n": 0}
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--bootstrap", type=int, default=1000)
    ap.add_argument("--no-export", action="store_true", help="evaluate only; leave src/data untouched")
    args = ap.parse_args()

    manifest = RunManifest("ml/train_confidence.py")
    train = load_table("train_confidence.csv")
    test = load_table("test_confidence.csv")
    gold = gold_ids()
    assert_no_leakage(train, test, gold)
    manifest.inputs += [eval_dir("train_confidence.csv"), eval_dir("test_confidence.csv")]

    all_features = columns_between(train, "abs_rel_error", "b0_v0_trust")
    if all_features != EXPECTED_FEATURES:
        raise SystemExit(f"feature columns {all_features} differ from {EXPECTED_FEATURES}; rebuild the tables")
    y = train["y"].astype(int).to_numpy()
    groups = train["domain"].to_numpy()
    pos = int(y.sum())
    minority = min(pos, len(y) - pos)
    report: dict = {
        "rows": {"train": len(train), "test": len(test), "train_positives": pos, "minority": minority},
        "label_sources": train["label_source"].value_counts().to_dict(),
    }
    print(f"train rows {len(train)} (positives {pos}); test rows {len(test)}")

    folds = group_folds(y, groups) if len(train) else []

    # Baselines, out of fold and on test.
    baselines = {}
    if len(train):
        baselines["B0_v0_trust"] = evaluate_sets(
            lambda d: d["b0_v0_trust"].to_numpy(float), train, train["b0_v0_trust"].to_numpy(float), test, args.bootstrap
        )
        baselines["B1_evidence_lookup"] = evaluate_sets(
            lambda d: b1(train, y, d), train, oof_baseline(b1, train, y, folds), test, args.bootstrap
        )
        baselines["B2_constant"] = evaluate_sets(
            lambda d: b2(train, y, d), train, oof_baseline(b2, train, y, folds), test, args.bootstrap
        )
    report["baselines"] = baselines

    if minority < MIN_MINORITY_TRAIN:
        report["decision"] = (
            f"Not trained: the minority class has {minority} rows (< {MIN_MINORITY_TRAIN}). "
            "The app keeps the v0 tier weights (B0) and does not show '% likely to fit'."
        )
        print(report["decision"])
        write_json(eval_dir("results", "confidence_model.json"), report)
        manifest.counts.update({"train_rows": len(train), "minority": minority})
        manifest.notes = report["decision"]
        manifest.write("skipped")
        return 0

    features = list(all_features)
    if minority < MIN_MINORITY_FULL:
        features = list(FALLBACK_FEATURES)
        report["feature_note"] = (
            f"Minority class has {minority} rows (< {MIN_MINORITY_FULL}); using 3 features "
            f"{FALLBACK_FEATURES} to keep roughly 10 events per feature [P10]."
        )
    X = matrix(train, features)

    best_C, cv_scores, oof_p = select_C(X, y, folds, features, SCALE_COLS)
    report["selection"] = {"C": best_C, "oof_log_loss_by_C": {str(k): v for k, v in cv_scores.items()}, "folds": len(folds)}
    pipe = build_pipeline(features, SCALE_COLS, best_C).fit(X, y)
    exported = export_logistic(pipe, features, SCALE_COLS)

    def predict_plain(d):
        return pipe.predict_proba(matrix(d, features))[:, 1]

    versions = {"unweighted": evaluate_sets(predict_plain, train, oof_p, test, args.bootstrap)}
    shipped = "unweighted"

    if minority / len(y) < IMBALANCE_SHARE:
        cal_oof = np.zeros(len(y))
        for tr, te in folds:
            cal_oof[te] = calibrated_balanced(features, best_C, X[tr], y[tr], groups[tr]).predict_proba(X[te])[:, 1]
        cal = calibrated_balanced(features, best_C, X, y, groups)
        versions["balanced_recalibrated"] = evaluate_sets(
            lambda d: cal.predict_proba(matrix(d, features))[:, 1], train, cal_oof, test, args.bootstrap
        )
        if versions["balanced_recalibrated"]["oof"]["log_loss"] < versions["unweighted"]["oof"]["log_loss"]:
            shipped = "balanced_recalibrated"
            base = cal.calibrated_classifiers_[0].estimator
            exported = export_logistic(base, features, SCALE_COLS)
            exported["calibration"] = sigmoid_params(cal)
        report["imbalance_note"] = (
            f"Minority share {minority / len(y):.1%} < {IMBALANCE_SHARE:.0%}: also trained with balanced weights "
            f"plus sigmoid recalibration; shipped the version with lower out-of-fold log loss ({shipped})."
        )
    report["versions"] = versions
    report["shipped_version"] = shipped

    # Export check: the JSON reproduces the fitted model.
    test_X = matrix(test, features) if len(test) else X[:1]
    reference = (
        cal.predict_proba(test_X)[:, 1] if shipped == "balanced_recalibrated" else pipe.predict_proba(test_X)[:, 1]
    )
    gap = float(np.max(np.abs(score_exported(exported, test_X) - reference)))
    if gap > 1e-9:
        raise SystemExit(f"exported model disagrees with scikit-learn by {gap}")
    parity_frame = test if len(test) else train
    write_parity("confidence", exported, parity_frame, features, reference if len(test) else pipe.predict_proba(X)[:, 1])
    if "balanced_recalibrated" in versions:
        if shipped == "balanced_recalibrated":
            alt, alt_p = export_logistic(pipe, features, SCALE_COLS), pipe.predict_proba(matrix(parity_frame, features))[:, 1]
        else:
            alt = export_logistic(cal.calibrated_classifiers_[0].estimator, features, SCALE_COLS)
            alt["calibration"] = sigmoid_params(cal)
            alt_p = cal.predict_proba(matrix(parity_frame, features))[:, 1]
        write_parity("confidence_alt", alt, parity_frame, features, alt_p)

    # Coefficients, read in plain English.
    report["coefficients"] = [
        {
            "feature": f,
            "coef": c,
            "odds_ratio": float(np.exp(c)),
            "per": "1 SD" if f in exported["scaler"] else "0 to 1",
            "sentence": odds_sentence(f, c, exported["scaler"].get(f)),
        }
        for f, c in zip(features, exported["coef"])
    ]

    # Sensitivity to the labeling threshold (5% and 20% instead of 10%).
    sens = {}
    for t in SENSITIVITY:
        yt = labels_at(train, t)
        if len(set(yt)) < 2:
            sens[f"{int(t * 100)}pct"] = {"note": "one class only"}
            continue
        ft = group_folds(yt, groups)
        Ct, _, oof_t = select_C(X, yt, ft, features, SCALE_COLS)
        pt = build_pipeline(features, SCALE_COLS, Ct).fit(X, yt)
        g = test[test["split"] == "test_gold"]
        sens[f"{int(t * 100)}pct"] = {
            "C": Ct,
            "train_positive_rate": float(yt.mean()),
            "oof": metrics_with_ci(yt, oof_t, groups, 0),
            "test_gold": metrics_with_ci(labels_at(g, t), pt.predict_proba(matrix(g, features))[:, 1], g["domain"], 0)
            if len(g)
            else {"n": 0},
        }
    report["sensitivity"] = sens

    # Reliability diagrams.
    shipped_predict = (
        (lambda d: cal.predict_proba(matrix(d, features))[:, 1]) if shipped == "balanced_recalibrated" else predict_plain
    )
    shipped_oof = cal_oof if shipped == "balanced_recalibrated" else oof_p
    g = test[test["split"] == "test_gold"]
    reliability_diagram(
        {
            "model, out of fold": (y, shipped_oof),
            "B0 v0 weights, out of fold": (y, train["b0_v0_trust"].to_numpy(float)),
            **({"model, test (gold)": (g["y"], shipped_predict(g))} if len(g) else {}),
        },
        eval_dir("results", "confidence_reliability.png"),
        "Room capacity confidence",
    )

    beats_b0 = None
    tg = versions[shipped].get("test_gold", {})
    b0g = baselines["B0_v0_trust"].get("test_gold", {})
    if tg.get("log_loss") is not None and b0g.get("log_loss") is not None:
        beats_b0 = tg["log_loss"] < b0g["log_loss"]
    report["beats_b0_on_test_gold_log_loss"] = beats_b0
    report["decision"] = (
        "Model beats B0 on test (gold) log loss."
        if beats_b0
        else "Model does NOT beat B0 on test (gold) log loss." if beats_b0 is False else "No gold test rows to compare."
    )

    model = {
        "model": "confidence",
        "version": model_version(),
        **exported,
        "trained_on": {
            "rows": int(len(y)),
            "positives": pos,
            "label_sources": {k: int(v) for k, v in train["label_source"].value_counts().items()},
        },
        "metrics": {k: {m: v for m, v in versions[shipped][k].items() if m != "ci95"} for k in versions[shipped]},
        "selection": {"C": best_C, "variant": shipped},
        "data_sha256": sha256_file(eval_dir("train_confidence.csv")),
        "git_sha": git_sha(),
        "seed": SEED,
    }
    write_json(eval_dir("results", "confidence_model.json"), report)
    out = model_dir() / "confidence-model.json"
    if not args.no_export:
        write_json(out, model)
        manifest.outputs.append(out)
    manifest.outputs += [eval_dir("results", "confidence_model.json"), eval_dir("results", "confidence_reliability.png")]
    manifest.models["confidence"] = model["version"]
    manifest.counts.update({"train_rows": len(y), "positives": pos, "test_rows": len(test), "C": best_C})
    manifest.write()

    print(f"C={best_C} ({shipped}); {report['decision']}")
    for name in ("oof", "test_gold", "test_la_gold", "test_la_teacher"):
        m = versions[shipped].get(name, {})
        b = baselines["B0_v0_trust"].get(name, {})
        if m.get("n"):
            print(
                f"  {name:16s} n={m['n']:4d}  log loss {m['log_loss']:.3f} (B0 {b['log_loss']:.3f})  "
                f"AUC {m['auc'] if m['auc'] is None else round(m['auc'], 3)}  ECE {m['ece_width']:.3f}"
            )
    for c in report["coefficients"]:
        print("  " + c["sentence"])
    return 0


if __name__ == "__main__":
    sys.exit(main())
