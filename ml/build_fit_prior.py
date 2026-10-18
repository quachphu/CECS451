"""Step 11: build the fit prior q(bucket, h), P(a venue's largest published room holds h guests).

    python3 ml/build_fit_prior.py

    q(bucket, h) = (n_with_room_at_least_h + alpha * q_global(h)) / (n_bucket + alpha),  alpha = 5

Train venues only, that host private events and publish at least one room size
(eval/fit_prior_venues.csv, written by 08_build_tables.ts). q is forced
non-increasing in h with a running minimum; the app interpolates linearly
between grid points. q is conditional on a published size: venues that host
events but publish no number are not in the denominator.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import numpy as np  # noqa: E402

from ml.common import (  # noqa: E402
    model_dir,
    SEED,
    RunManifest,
    eval_dir,
    git_sha,
    gold_ids,
    load_table,
    model_version,
    sha256_file,
    write_atomic,
    write_json,
)

HEADCOUNTS = [10, 20, 30, 40, 50, 75, 100, 150, 200, 300]
ALPHA = 5.0
BUCKETS = [
    "fine_dining",
    "casual_restaurant",
    "steakhouse_grill",
    "bar_lounge",
    "hotel",
    "event_space",
    "fast_casual_cafe",
]
REPORT_AT = [30, 50, 200]


def running_min(q) -> list[float]:
    return [float(v) for v in np.minimum.accumulate(np.asarray(q, dtype=float))]


def fit_prior_table(max_rooms_by_bucket: dict[str, list[float]], alpha: float = ALPHA, grid=HEADCOUNTS) -> dict:
    everything = [m for ms in max_rooms_by_bucket.values() for m in ms]
    n_all = len(everything)
    q_global = running_min([sum(m >= h for m in everything) / n_all if n_all else 0.0 for h in grid])
    buckets = {}
    for b in BUCKETS:
        ms = max_rooms_by_bucket.get(b, [])
        raw = [(sum(m >= h for m in ms) + alpha * g) / (len(ms) + alpha) for h, g in zip(grid, q_global)]
        buckets[b] = {"q": running_min(raw), "n": len(ms)}
    return {"global": {"q": q_global, "n": n_all}, "buckets": buckets}


def main() -> int:
    manifest = RunManifest("ml/build_fit_prior.py")
    rows = load_table("fit_prior_venues.csv")
    train = rows[rows["split"] == "train"]
    gold = gold_ids()
    if set(train["venue_id"]) & gold or (train["city"] == "LA").any():
        raise SystemExit("fit prior leakage: gold or LA venue in the train rows")
    unknown = set(train["fit_bucket"]) - set(BUCKETS)
    if unknown:
        raise SystemExit(f"unknown buckets {unknown}")
    by_bucket = {b: train.loc[train["fit_bucket"] == b, "max_room"].astype(float).tolist() for b in BUCKETS}
    table = fit_prior_table(by_bucket)

    test = rows[rows["split"] != "train"]
    test_check = {}
    if len(test):
        # How well q predicts "largest room >= h" on held-out venues (Brier, per headcount, all buckets pooled).
        for h_i, h in enumerate(HEADCOUNTS):
            q = np.array([table["buckets"][b]["q"][h_i] for b in test["fit_bucket"]])
            obs = (test["max_room"].astype(float) >= h).to_numpy(float)
            qg = np.full(len(obs), table["global"]["q"][h_i])
            test_check[str(h)] = {"brier_bucket": float(np.mean((q - obs) ** 2)), "brier_global": float(np.mean((qg - obs) ** 2))}

    model = {
        "model": "fit_prior",
        "version": model_version(),
        "alpha": ALPHA,
        "headcounts": HEADCOUNTS,
        "global": table["global"],
        "buckets": table["buckets"],
        "note": "q is conditional on a published room size: venues that host events but publish no number are not counted.",
        "trained_on": {"venues": int(len(train))},
        "data_sha256": sha256_file(eval_dir("fit_prior_venues.csv")),
        "git_sha": git_sha(),
        "seed": SEED,
    }
    out = model_dir() / "fit-priors.json"
    if "--no-export" not in sys.argv:
        write_json(out, model)
        manifest.outputs.append(out)

    idx = [HEADCOUNTS.index(h) for h in REPORT_AT]
    lines = [
        "| Bucket | n | " + " | ".join(f"q({h})" for h in REPORT_AT) + " |",
        "| --- | ---: | " + " | ".join("---:" for _ in REPORT_AT) + " |",
    ]
    for b in BUCKETS:
        e = table["buckets"][b]
        lines.append(f"| {b} | {e['n']} | " + " | ".join(f"{e['q'][i]:.2f}" for i in idx) + " |")
    g = table["global"]
    lines.append(f"| all (global) | {g['n']} | " + " | ".join(f"{g['q'][i]:.2f}" for i in idx) + " |")
    write_json(eval_dir("results", "fit_prior.json"), {**model, "test_check": test_check, "table_md": "\n".join(lines)})
    write_atomic(eval_dir("results", "fit_prior_table.md"), "\n".join(lines) + "\n")
    manifest.inputs.append(eval_dir("fit_prior_venues.csv"))
    manifest.outputs += [eval_dir("results", "fit_prior.json")]
    manifest.models["fit_prior"] = model["version"]
    manifest.counts["train_venues"] = int(len(train))
    manifest.write()
    print("\n".join(lines))
    return 0


if __name__ == "__main__":
    sys.exit(main())
