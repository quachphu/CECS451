"""
Candidate confidence: one row per number on a saved page.

  .venv/bin/python ml/train_candidates.py --no-export

No class weights on the first fit. Does not write src/data.
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
    eval_dir,
    export_logistic,
    git_sha,
    gold_ids,
    group_folds,
    brier,
    load_table,
    log_loss,
    metrics_with_ci,
    model_version,
    odds_sentence,
    select_C,
    sha256_file,
    test_subsets,
    model_dir,
    read_json,
    write_json,
    write_parity,
    REPO,
    RunManifest,
)

FEATURES = [
    "llm_votes",
    "regex_hit",
    "in_grounded_quote",
    "room_word_near",
    "capacity_verb_near",
    "reservation_phrase_near",
    "whole_venue_phrase_near",
    "looks_like_junk",
    "on_private_page",
    "value_rank",
    "log_value",
    "n_candidates_on_page",
]
SCALE_COLS = ["llm_votes", "value_rank", "log_value", "n_candidates_on_page"]


def pick_accuracy(frame, scores, positives_only: bool = False) -> float | None:
    """Share of venues whose highest-scoring candidate is a correct room figure.

    positives_only keeps venues that have at least one correct number, so a page
    with no teacher room does not count as a miss.
    """
    if len(frame) == 0:
        return None
    work = frame.copy()
    work["_s"] = np.asarray(scores, dtype=float)
    hits = venues = 0
    for _, group in work.groupby("venue_id", sort=False):
        if positives_only and not (group["y"].astype(int) == 1).any():
            continue
        venues += 1
        hits += int(group.loc[group["_s"].idxmax(), "y"] == 1)
    return hits / venues if venues else None


def flag_accuracy(frame, column: str, positives_only: bool = False) -> float | None:
    """Share of venues where the flagged row is correct. A venue with no flag is a miss."""
    if len(frame) == 0:
        return None
    hits = venues = 0
    for _, group in frame.groupby("venue_id", sort=False):
        if positives_only and not (group["y"].astype(int) == 1).any():
            continue
        venues += 1
        flagged = group[group[column].astype(int) == 1]
        hits += int(len(flagged) > 0 and (flagged["y"].astype(int) == 1).any())
    return hits / venues if venues else None


def selection_block(frame, scores) -> dict:
    return {
        "all_venues": {
            "model": pick_accuracy(frame, scores),
            "largest_regex": flag_accuracy(frame, "is_largest_regex"),
            "pipeline_winner": flag_accuracy(frame, "is_pipeline_winner"),
            "heuristic": pick_accuracy(frame, heuristic_scores(frame)),
            "venues": int(frame["venue_id"].nunique()) if len(frame) else 0,
        },
        "venues_with_a_correct_number": {
            "model": pick_accuracy(frame, scores, positives_only=True),
            "largest_regex": flag_accuracy(frame, "is_largest_regex", positives_only=True),
            "pipeline_winner": flag_accuracy(frame, "is_pipeline_winner", positives_only=True),
            "heuristic": pick_accuracy(frame, heuristic_scores(frame), positives_only=True),
            "venues": int(frame.loc[frame["y"].astype(int) == 1, "venue_id"].nunique()) if len(frame) else 0,
        },
    }


def tier_weight(frame) -> np.ndarray:
    """v0 trust for a displayed figure: 0.9 on a private-dining page, otherwise 0.3."""
    private = frame["on_private_page"].astype(int).to_numpy() == 1
    return np.where(private, 0.9, 0.3)


def against_tier(frame, scores) -> dict | None:
    """Log loss and Brier of the model versus the tier weight, on numbers the pipeline would show."""
    shown = frame[frame["is_pipeline_winner"].astype(int) == 1]
    if len(shown) == 0:
        return None
    y = shown["y"].astype(int).to_numpy()
    p = np.asarray(scores, dtype=float)[frame["is_pipeline_winner"].astype(int).to_numpy() == 1]
    t = tier_weight(shown)
    return {
        "n": int(len(shown)),
        "positives": int(y.sum()),
        "model_log_loss": log_loss(y, p),
        "tier_log_loss": log_loss(y, t),
        "model_brier": brier(y, p),
        "tier_brier": brier(y, t),
        "model_mean": float(p.mean()),
        "tier_mean": float(t.mean()),
    }


def heuristic_scores(frame) -> np.ndarray:
    return (
        frame["llm_votes"].astype(float).to_numpy()
        + frame["in_grounded_quote"].astype(float).to_numpy()
        + frame["regex_hit"].astype(float).to_numpy()
    )


def main() -> int:
    export = "--export" in sys.argv
    manifest = RunManifest("ml/train_candidates.py")
    train = load_table("train_candidates.csv")
    test = load_table("test_candidates.csv")
    assert_no_leakage(train, test, gold_ids())
    y = train["y"].astype(int).to_numpy()
    n_pos = int(y.sum())
    n_venues = int(train.loc[train["y"] == 1, "venue_id"].nunique())
    print(f"candidate rows train={len(train)} positives={n_pos} from {n_venues} venues; test={len(test)}")
    if n_pos < 15 or (len(y) - n_pos) < 15:
        decision = "Not trained: a candidate class has fewer than 15 rows."
        write_json(eval_dir("results", "candidate_model.json"), {"decision": decision, "train_positives": n_pos, "train_positive_venues": n_venues})
        print(decision)
        return 0

    X = train[FEATURES].to_numpy(float)
    folds = group_folds(y, train["domain"].tolist())
    C, grid, oof = select_C(X, y, folds, FEATURES, SCALE_COLS, class_weight=None)
    pipe = build_pipeline(FEATURES, SCALE_COLS, C, class_weight=None)
    pipe.fit(X, y)
    exported = export_logistic(pipe, FEATURES, SCALE_COLS)
    coefs = dict(zip(FEATURES, exported["coef"]))

    selection = selection_block(train, oof)
    tier = {"oof": against_tier(train, oof)}
    report = {
        "model": "candidate_confidence",
        "version": model_version(),
        "class_weight": None,
        "C": C,
        "C_grid_log_loss": {str(k): v for k, v in grid.items()},
        "train_rows": int(len(train)),
        "train_positives": n_pos,
        "train_positive_venues": n_venues,
        "oof": metrics_with_ci(y, oof, train["domain"]),
        "selection_train": selection,
        "calibration_vs_tier": tier,
        "odds": [odds_sentence(f, coefs[f], exported["scaler"].get(f)) for f in FEATURES],
        "test": {},
        "decision": "",
        "git_sha": git_sha(),
        "data_sha256": sha256_file(eval_dir("train_candidates.csv")),
        "seed": SEED,
    }
    for name, subset in test_subsets(test).items():
        if len(subset) == 0 or subset["y"].nunique() < 2:
            continue
        p = pipe.predict_proba(subset[FEATURES].to_numpy(float))[:, 1]
        report["test"][name] = {
            "n": int(len(subset)),
            "positives": int(subset["y"].sum()),
            "venues": int(subset["venue_id"].nunique()),
            "model": metrics_with_ci(subset["y"].astype(int).to_numpy(), p, subset["domain"]),
            "selection": selection_block(subset, p),
        }
        tier[name] = against_tier(subset, p)
    gold = report["test"].get("test_gold", {})
    gold_sel = (gold.get("selection") or {}).get("venues_with_a_correct_number") or {}
    beats_selection = (
        gold_sel.get("model") is not None
        and gold_sel["model"] > max(gold_sel.get("largest_regex") or 0, gold_sel.get("heuristic") or 0)
    )
    gold_tier = tier.get("test_gold") or {}
    beats_tier = (
        gold_tier.get("model_log_loss") is not None
        and gold_tier["model_log_loss"] < gold_tier["tier_log_loss"]
    )
    report["decision"] = (
        f"Trained on {n_pos} positive candidates from {n_venues} venues. "
        + (
            "On gold venues that have a correct number, selection beats the largest-regex and heuristic baselines. "
            if beats_selection
            else "On gold venues that have a correct number, selection does not beat both baselines. "
        )
        + (
            "On the numbers the pipeline would show, its log loss beats the tier weight. "
            if beats_tier
            else "On the numbers the pipeline would show, its log loss does not beat the tier weight. "
        )
        + (
            "Exported to src/data/confidence-model.json. The displayed number is still chosen by votes, a quote, and a regex hit."
            if export
            else "Not exported. The app keeps the tier weights."
        )
    )
    write_json(eval_dir("results", "candidate_model.json"), report)
    if export:
        shipped = {
            "model": "confidence",
            "version": report["version"],
            "description": "P(a displayed candidate number is within 10% of a teacher room size). Serving caps this probability at 0.979, just below a planner confirmation of 0.98.",
            **exported,
        }
        write_json(model_dir() / "confidence-model.json", shipped)
        parity_frame = test if len(test) else train
        reference = pipe.predict_proba(parity_frame[FEATURES].to_numpy(float))[:, 1]
        write_parity("confidence", exported, parity_frame, FEATURES, reference)
        fixture_path = REPO / "src" / "lib" / "discovery" / "__fixtures__" / "model-parity.json"
        fixture = read_json(fixture_path)
        parity = read_json(eval_dir("results", "parity", "confidence.json"))
        fixture["models"]["confidence"] = {"model": parity["model"], "rows": parity["rows"]}
        fixture["model_versions"]["confidence"] = report["version"]
        write_json(fixture_path, fixture)
    manifest.outputs.append(eval_dir("results", "candidate_model.json"))
    manifest.models["candidate_confidence"] = report["version"]
    manifest.counts = {"train_rows": int(len(train)), "train_positives": n_pos, "train_positive_venues": n_venues}
    manifest.write()
    print(report["decision"])
    print("selection", selection)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
