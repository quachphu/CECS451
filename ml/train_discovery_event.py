"""
Pre-fetch discovery for "this readable site has event content."

  .venv/bin/python ml/train_discovery_event.py --no-export

The label is a private-dining page, event wording, or an external event link.
Those signals are not model features. Does not write src/data.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import numpy as np

from ml.common import (
    SEED,
    assert_no_leakage,
    build_pipeline,
    columns_between,
    ece,
    eval_dir,
    export_logistic,
    git_sha,
    gold_ids,
    group_folds,
    load_table,
    metrics_with_ci,
    model_version,
    reliability_diagram,
    select_C,
    sha256_file,
    test_subsets,
    write_json,
    RunManifest,
)
from ml.train_discovery import yield_at_k

ID_COLS = ["venue_id", "domain", "city", "bucket", "split", "label_source", "y"]


def main() -> int:
    manifest = RunManifest("ml/train_discovery_event.py")
    train = load_table("train_discovery_event.csv")
    test = load_table("test_discovery_event.csv")
    assert_no_leakage(train, test, gold_ids())
    features = columns_between(train, "y", "v0_prior")
    if "has_external_event_link" in features or "private_page_found" in features:
        raise SystemExit("event-content features include the label signal")
    y = train["y"].astype(int).to_numpy()
    print(f"event discovery train={len(train)} positives={int(y.sum())} features={features}")
    X = train[features].to_numpy(float)
    folds = group_folds(y, train["domain"].tolist())
    C, grid, oof = select_C(X, y, folds, features, features, class_weight=None)
    pipe = build_pipeline(features, features, C, class_weight=None)
    pipe.fit(X, y)
    exported = export_logistic(pipe, features, features)

    def block(frame, scores, v0):
        yy = frame["y"].astype(int).to_numpy()
        return {
            "n": int(len(frame)),
            "positives": int(yy.sum()),
            "model": metrics_with_ci(yy, scores, frame["domain"]),
            "v0": metrics_with_ci(yy, v0, frame["domain"]),
            "yield": {
                "10": {"model": yield_at_k(yy, scores, 10), "v0": yield_at_k(yy, v0, 10)},
                "25": {"model": yield_at_k(yy, scores, 25), "v0": yield_at_k(yy, v0, 25)},
            },
            "ece": ece(yy, scores),
        }

    v0_train = train["v0_prior"].astype(float).to_numpy()
    report = {
        "model": "discovery_event_pre_fetch",
        "version": model_version(),
        "features": features,
        "C": C,
        "C_grid_log_loss": {str(k): v for k, v in grid.items()},
        "oof": block(train, oof, v0_train),
        "test": {},
        "coef": exported["coef"],
        "intercept": exported["intercept"],
        "decision": "",
        "git_sha": git_sha(),
        "data_sha256": sha256_file(eval_dir("train_discovery_event.csv")),
        "seed": SEED,
    }
    for name, subset in test_subsets(test).items():
        if len(subset) == 0 or subset["y"].nunique() < 2:
            continue
        p = pipe.predict_proba(subset[features].to_numpy(float))[:, 1]
        report["test"][name] = block(subset, p, subset["v0_prior"].astype(float).to_numpy())

    def logit_prior(frame):
        p = np.clip(frame["v0_prior"].astype(float).to_numpy(), 1e-4, 1 - 1e-4)
        return np.log(p / (1 - p))

    def design(frame, cols):
        if cols == ["logit_v0"]:
            return logit_prior(frame).reshape(-1, 1)
        return np.column_stack([frame[features].to_numpy(float), logit_prior(frame)])

    def fit_variant(frame, cols, scale):
        xx = design(frame, cols)
        cc, grid_c, oof_c = select_C(xx, y, folds, cols, scale, class_weight=None)
        fitted = build_pipeline(cols, scale, cc, class_weight=None)
        fitted.fit(xx, y)
        return cc, grid_c, oof_c, fitted

    def variant_scores(fitted, frame, cols):
        return fitted.predict_proba(design(frame, cols))[:, 1]

    # The residual model starts from the v0 log-odds and lets the pre-fetch features correct it.
    train_r = train.copy()
    prior_cols = ["logit_v0"]
    residual_cols = features + ["logit_v0"]
    c_prior, grid_prior, oof_prior, pipe_prior = fit_variant(train_r, prior_cols, ["logit_v0"])
    c_res, grid_res, oof_res, pipe_res = fit_variant(train_r, residual_cols, features)

    residual = {
        "prior_only": {"C": c_prior, "C_grid_log_loss": {str(k): v for k, v in grid_prior.items()}, "oof": block(train, oof_prior, v0_train)},
        "residual": {"C": c_res, "C_grid_log_loss": {str(k): v for k, v in grid_res.items()}, "oof": block(train, oof_res, v0_train), "features": residual_cols},
        "test": {},
    }
    for name, subset in test_subsets(test).items():
        if len(subset) == 0 or subset["y"].nunique() < 2:
            continue
        v0s = subset["v0_prior"].astype(float).to_numpy()
        residual["test"][name] = {
            "prior_only": block(subset, variant_scores(pipe_prior, subset, prior_cols), v0s),
            "residual": block(subset, variant_scores(pipe_res, subset, residual_cols), v0s),
        }
    report["residual"] = residual

    gold = report["test"].get("test_gold", {})
    beats = False
    if gold:
        beats = gold["model"]["auc"] > gold["v0"]["auc"] and gold["yield"]["10"]["model"] >= gold["yield"]["10"]["v0"]
    residual_gold = (residual["test"].get("test_gold") or {}).get("residual") or {}
    prior_gold = (residual["test"].get("test_gold") or {}).get("prior_only") or {}
    residual_helps = (
        residual_gold
        and residual_gold["model"]["log_loss"] < gold["v0"]["log_loss"]
        and residual_gold["model"]["log_loss"] < prior_gold["model"]["log_loss"]
    )
    report["decision"] = (
        "Pre-fetch event-content model "
        + ("beats the v0 prior on gold-test AUC and yield@10. " if beats else "does not beat the v0 prior on both gold-test AUC and yield@10. ")
        + (
            "The residual model, which corrects the v0 log-odds, lowers gold-test log loss. "
            if residual_helps
            else "The residual model does not lower gold-test log loss below both the raw prior and a recalibrated prior. "
        )
        + "Not exported."
    )
    reliability_diagram({"oof": (y, oof)}, eval_dir("results", "discovery_event_reliability.png"), "Event-content discovery, out of fold")
    write_json(eval_dir("results", "discovery_event_model.json"), report)
    manifest.outputs.append(eval_dir("results", "discovery_event_model.json"))
    manifest.models["discovery_event"] = report["version"]
    manifest.counts = {"train": int(len(train)), "train_positives": int(y.sum())}
    manifest.write()
    print(report["decision"])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
