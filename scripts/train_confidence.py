#!/usr/bin/env python3
"""
Refit the capacity-confidence model (src/data/confidence-model.json).

Offline only — never imported by the app. Reads:
  --labels    eval/labels.csv        human-labelled ground truth (eval/README.md)
  --features  eval/features.jsonl    one row per predicted room, written by
                                     scripts/eval-extraction.ts (the features
                                     buildVenueDraft computed for that room)

A predicted room is *correct* when it matches a labelled room for the same
venue and its capacity is within ±10% of the labelled max_capacity. Rooms of a
venue labelled hosts_private_events=0 are incorrect by definition.

Fits sklearn LogisticRegression [D9] — logistic outputs are the sigmoid
calibration of Platt [P6], usually well calibrated on small data
(Niculescu-Mizil & Caruana 2005 [P6]) — and reports Expected Calibration Error
with 10 equal-width bins (Naeini et al. 2015 [P5]; Guo et al. 2017 [P4]):

    ECE = sum_b (n_b / N) * |acc(b) - conf(b)|

computed both in-sample and on 5-fold cross-validated predictions, plus a
reliability table (sklearn calibration_curve [D8]). The current model's ECE on
the same rows is printed for comparison.

--target prior refits the discovery prior (src/data/discovery-prior.json)
instead: P(hosts_private_events) from candidate metadata in
eval/candidates.jsonl (written by scripts/eval-snapshot.ts), joined to the
labels' hosts_private_events column by venue_key.

Usage:
  pip install -r requirements-dev.txt
  python3 scripts/train_confidence.py --labels eval/labels.csv --features eval/features.jsonl
  python3 scripts/train_confidence.py ... --dry-run      # report only, write nothing
  python3 scripts/train_confidence.py --target prior --candidates eval/candidates.jsonl
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import math
import re
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.calibration import calibration_curve
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import StratifiedKFold, cross_val_predict

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_MODEL = ROOT / "src" / "data" / "confidence-model.json"

SOURCES = ["planner", "both", "llm", "regex", "estimate"]
BUCKETS = ["banquet", "hotel", "bar", "club", "restaurant", "other"]
NUMERIC = ["agreementSpread", "privateDiningPageFound", "grounded", "competingCandidates", "hasRoomHint", "renderedWithJs"]
FEATURE_NAMES = [f"source={s}" for s in SOURCES] + NUMERIC + [f"category={b}" for b in BUCKETS]


def category_bucket(category: str | None) -> str:
    """Port of src/lib/category-bucket.ts — keep the two in step."""
    c = (category or "").lower()
    if re.search(r"banquet|ballroom|event[\s_-]*(space|venue|hall)|events_venue|conference", c):
        return "banquet"
    if re.search(r"hotel|resort|lodging", c):
        return "hotel"
    if re.search(r"night|club", c):
        return "club"
    if re.search(r"\bbar\b|pub|lounge|tavern|brewery|wine", c):
        return "bar"
    if re.search(r"restaurant|dining|grill|steak|italian|mexican|greek|american|seafood|bistro|cafe|cuisine|kitchen|food", c):
        return "restaurant"
    return "other"


def encode(features: dict) -> list[float]:
    """Port of encodeConfidenceFeatures in src/lib/discovery/confidence.ts."""
    x = dict.fromkeys(FEATURE_NAMES, 0.0)
    x[f"source={features['source']}"] = 1.0
    x["agreementSpread"] = float(features.get("agreementSpread") or 0.0)
    for name in ["privateDiningPageFound", "grounded", "hasRoomHint", "renderedWithJs"]:
        x[name] = 1.0 if features.get(name) else 0.0
    x["competingCandidates"] = float(features.get("competingCandidates") or 0)
    x[f"category={category_bucket(features.get('category'))}"] = 1.0
    return [x[n] for n in FEATURE_NAMES]


PRIOR_KINDS = ["banquet", "hotel", "steakhouse", "restaurant", "bar", "night_club", "cafe", "fast_food"]
PRIOR_NAME_KEYWORDS = ["steakhouse", "grill", "tavern", "hall", "club", "hotel", "pizza", "express", "cafe"]
PRIOR_FEATURES = ["priceLevel", "priceLevelMissing", "hasWebsite"] + [f"kind={k}" for k in PRIOR_KINDS] + [
    f"name={w}" for w in PRIOR_NAME_KEYWORDS
]
PRIOR_KIND_PATTERNS = {
    "banquet": r"banquet|event[_\s-]*(venue|hall|space)|events_venue|wedding_venue|convention|conference",
    "hotel": r"hotel|resort|lodging|motel",
    "steakhouse": r"steak",
    "restaurant": r"restaurant|dining",
    "bar": r"\bbar\b|(^|[_\s])bar([_\s]|$)|\bpub\b|wine_bar|cocktail|brewery",
    "night_club": r"night[_\s-]*club|nightclub",
    "cafe": r"cafe|coffee|bakery|tea_house",
    "fast_food": r"fast[_\s-]*food|meal_takeaway|sandwich|hamburger|pizza_delivery|food_court",
}
DEFAULT_PRIOR = ROOT / "src" / "data" / "discovery-prior.json"


def encode_prior(c: dict) -> list[float]:
    """Port of encodePriorFeatures in src/lib/discovery/discovery-prior.ts."""
    kind_text = " ".join(str(v) for v in [c.get("category"), c.get("cuisine"), *(c.get("types") or [])] if v).lower()
    name = str(c.get("name") or "").lower()
    price = c.get("priceLevelGoogle")
    x = dict.fromkeys(PRIOR_FEATURES, 0.0)
    x["priceLevel"] = float(price or 0)
    x["priceLevelMissing"] = 1.0 if price is None else 0.0
    x["hasWebsite"] = 1.0 if c.get("website") else 0.0
    for kind, pattern in PRIOR_KIND_PATTERNS.items():
        if re.search(pattern, kind_text):
            x[f"kind={kind}"] = 1.0
    for word in PRIOR_NAME_KEYWORDS:
        if re.search(rf"\b{word}", name):
            x[f"name={word}"] = 1.0
    return [x[n] for n in PRIOR_FEATURES]


def train_prior(args: argparse.Namespace) -> int:
    labels = pd.read_csv(args.labels)
    hosts = labels.groupby(labels["venue_key"].astype(str))["hosts_private_events"].max().astype(int).to_dict()
    rows = [json.loads(l) for l in args.candidates.read_text().splitlines() if l.strip()]
    rows = [r for r in rows if str(r.get("venue_key")) in hosts]
    X = np.array([encode_prior(r) for r in rows], dtype=float)
    y = np.array([hosts[str(r["venue_key"])] for r in rows], dtype=int)
    print(f"candidates joined: {len(y)}  (hosts {int(y.sum())}, not {int(len(y) - y.sum())})")
    if len(y) < args.min_rows or len(set(y.tolist())) < 2:
        print(f"Need at least {args.min_rows} rows with both outcomes to fit; not writing a model.", file=sys.stderr)
        return 1
    clf = LogisticRegression(C=1.0, max_iter=2000).fit(X, y)
    p = clf.predict_proba(X)[:, 1]
    print(f"in-sample ECE = {expected_calibration_error(p, y):.4f}")
    model = {
        "version": f"lr-{dt.date.today().isoformat()}",
        "description": f"LogisticRegression refit on {len(y)} labelled candidates (hosts_private_events).",
        "intercept": round(float(clf.intercept_[0]), 4),
        "weights": {n: round(float(w), 4) for n, w in zip(PRIOR_FEATURES, clf.coef_[0])},
    }
    if args.dry_run:
        print(json.dumps(model, indent=2))
        return 0
    out = args.out if args.out != DEFAULT_MODEL else DEFAULT_PRIOR
    out.write_text(json.dumps(model, indent=2) + "\n")
    print(f"wrote {out}")
    return 0


def normalize_room(name: str) -> str:
    """Port of normalizeRoomName in src/lib/discovery/trust.ts."""
    s = re.sub(r"[’'\".,()]", "", (name or "").lower())
    s = re.sub(r"\b(the|our|private)\b", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def same_room(a: str, b: str) -> bool:
    a, b = normalize_room(a), normalize_room(b)
    return bool(a) and bool(b) and (a == b or a in b or b in a)


def expected_calibration_error(conf: np.ndarray, correct: np.ndarray, n_bins: int = 10) -> float:
    """ECE per Naeini et al. 2015 [P5], binning as in gpleiss/temperature_scaling [C2]
    (left-open bins), except the first bin also includes 0 so a 0.0 score isn't dropped."""
    edges = np.linspace(0, 1, n_bins + 1)
    ece = 0.0
    for i, (lo, hi) in enumerate(zip(edges[:-1], edges[1:])):
        in_bin = (conf > lo) & (conf <= hi) if i > 0 else (conf >= lo) & (conf <= hi)
        if in_bin.any():
            ece += in_bin.mean() * abs(correct[in_bin].mean() - conf[in_bin].mean())
    return float(ece)


def reliability_table(conf: np.ndarray, correct: np.ndarray, n_bins: int = 10) -> pd.DataFrame:
    edges = np.linspace(0, 1, n_bins + 1)
    rows = []
    for i, (lo, hi) in enumerate(zip(edges[:-1], edges[1:])):
        in_bin = (conf > lo) & (conf <= hi) if i > 0 else (conf >= lo) & (conf <= hi)
        n = int(in_bin.sum())
        rows.append(
            {
                "bin": f"({lo:.1f}, {hi:.1f}]" if i > 0 else f"[{lo:.1f}, {hi:.1f}]",
                "n": n,
                "mean_confidence": round(float(conf[in_bin].mean()), 3) if n else None,
                "accuracy": round(float(correct[in_bin].mean()), 3) if n else None,
            }
        )
    return pd.DataFrame(rows)


def score_with(model: dict, X: np.ndarray) -> np.ndarray:
    w = np.array([model["weights"].get(n, 0.0) for n in FEATURE_NAMES])
    return 1 / (1 + np.exp(-(X @ w + model.get("intercept", 0.0))))


def join(labels: pd.DataFrame, features: list[dict]) -> tuple[np.ndarray, np.ndarray]:
    labels = labels.copy()
    labels["venue_key"] = labels["venue_key"].astype(str)
    by_venue = {k: g for k, g in labels.groupby("venue_key")}
    X, y = [], []
    for row in features:
        venue = by_venue.get(str(row["venue_key"]))
        if venue is None:
            continue  # unlabelled venue: no ground truth
        hosts = venue["hosts_private_events"].astype(int).max() == 1
        rooms = venue.dropna(subset=["max_capacity"])
        correct = 0
        if hosts and len(rooms) > 0:
            match = rooms[rooms["room_name"].fillna("").map(lambda n: same_room(n, row["room_name"]))]
            if match.empty and len(rooms) == 1:
                match = rooms
            if not match.empty:
                truth = float(match.iloc[0]["max_capacity"])
                correct = int(truth > 0 and abs(row["max_capacity"] - truth) / truth <= 0.10)
        X.append(encode(row["features"]))
        y.append(correct)
    return np.array(X, dtype=float), np.array(y, dtype=int)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--labels", type=Path, default=ROOT / "eval" / "labels.csv")
    ap.add_argument("--features", type=Path, default=ROOT / "eval" / "features.jsonl")
    ap.add_argument("--system", default="combined", help="which eval system's predictions to train on")
    ap.add_argument("--out", type=Path, default=DEFAULT_MODEL)
    ap.add_argument("--min-rows", type=int, default=30)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--target", choices=["confidence", "prior"], default="confidence")
    ap.add_argument("--candidates", type=Path, default=ROOT / "eval" / "candidates.jsonl")
    args = ap.parse_args()
    if args.target == "prior":
        return train_prior(args)

    labels = pd.read_csv(args.labels)
    features = [json.loads(line) for line in args.features.read_text().splitlines() if line.strip()]
    features = [f for f in features if f.get("system", "combined") == args.system]
    X, y = join(labels, features)

    print(f"rows joined: {len(y)}  (positives {int(y.sum())}, negatives {int(len(y) - y.sum())})")
    if len(y) < args.min_rows or len(set(y.tolist())) < 2:
        print(f"Need at least {args.min_rows} rows with both outcomes to fit; not writing a model.", file=sys.stderr)
        return 1

    current = json.loads(DEFAULT_MODEL.read_text())
    p_current = score_with(current, X)
    print(f"\ncurrent model ({current['version']}): ECE = {expected_calibration_error(p_current, y):.4f}")

    clf = LogisticRegression(C=1.0, max_iter=2000)
    folds = min(5, int(min(y.sum(), len(y) - y.sum())))
    p_cv = (
        cross_val_predict(clf, X, y, cv=StratifiedKFold(folds, shuffle=True, random_state=0), method="predict_proba")[:, 1]
        if folds >= 2
        else None
    )
    clf.fit(X, y)
    p_fit = clf.predict_proba(X)[:, 1]

    print(f"refit, in-sample:        ECE = {expected_calibration_error(p_fit, y):.4f}")
    if p_cv is not None:
        print(f"refit, {folds}-fold CV:        ECE = {expected_calibration_error(p_cv, y):.4f}")
    print("\nreliability (refit, " + ("cross-validated" if p_cv is not None else "in-sample") + "):")
    print(reliability_table(p_cv if p_cv is not None else p_fit, y).to_string(index=False))
    frac_pos, mean_pred = calibration_curve(y, p_cv if p_cv is not None else p_fit, n_bins=10, strategy="uniform")
    print("\nsklearn calibration_curve (non-empty bins): " + ", ".join(f"{m:.2f}->{f:.2f}" for m, f in zip(mean_pred, frac_pos)))

    model = {
        "version": f"lr-{dt.date.today().isoformat()}",
        "description": f"LogisticRegression refit on {len(y)} labelled rooms from {args.labels.name}; "
        + (f"{folds}-fold CV ECE {expected_calibration_error(p_cv, y):.4f}." if p_cv is not None else "no CV (too few rows)."),
        "intercept": round(float(clf.intercept_[0]), 4),
        "weights": {name: round(float(w), 4) for name, w in zip(FEATURE_NAMES, clf.coef_[0])},
    }
    if args.dry_run:
        print("\n--dry-run: model not written:\n" + json.dumps(model, indent=2))
        return 0
    args.out.write_text(json.dumps(model, indent=2) + "\n")
    print(f"\nwrote {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
