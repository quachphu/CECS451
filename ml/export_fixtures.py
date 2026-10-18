"""Step 12: write the TypeScript parity fixture.

    python3 ml/export_fixtures.py [--source "dry run"]

Collects the rows the trainers saved in eval/results/parity/ (30 rows each,
with scikit-learn's predict_proba) and the fit-prior table, and writes
src/lib/discovery/__fixtures__/model-parity.json. model-scoring.test.ts checks
the TypeScript scores match within 1e-6, and that a trained model in src/data
has the version recorded in the fixture (so retraining forces a re-export).
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import numpy as np  # noqa: E402

from ml.common import REPO, eval_dir, model_dir, read_json, score_exported, write_json  # noqa: E402

OUT = REPO / "src" / "lib" / "discovery" / "__fixtures__" / "model-parity.json"
FIT_POINTS = [5, 10, 15, 30, 42, 60, 100, 120, 250, 300, 500]


def fit_prior_reference(model: dict, bucket: str, h: float) -> float:
    """Linear interpolation over the headcount grid, clamped to its ends (what fitPrior does)."""
    table = model["buckets"].get(bucket, model["global"])
    return float(np.interp(h, model["headcounts"], table["q"]))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", default="eval/ (real data)", help="where the models were trained, for the record")
    ap.add_argument("--out", default=str(OUT), help="fixture path (default: the one the parity test reads)")
    args = ap.parse_args()

    models = {}
    for path in sorted(eval_dir("results", "parity").glob("*.json")):
        entry = read_json(path)
        # Guard: the saved rows still agree with the saved model under the reference scorer.
        feats = entry["model"]["feature_order"]
        X = np.array([[np.nan if r["x"][f] is None else r["x"][f] for f in feats] for r in entry["rows"]], dtype=float)
        if len(X):
            gap = np.max(np.abs(score_exported(entry["model"], X) - np.array([r["p"] for r in entry["rows"]])))
            if gap > 1e-9:
                raise SystemExit(f"{path.name}: rows disagree with the model by {gap}")
        models[entry["name"]] = {"model": entry["model"], "rows": entry["rows"]}
    if not models:
        raise SystemExit("no parity rows in eval/results/parity/; run the training scripts first")

    fit = None
    fit_file = model_dir() / "fit-priors.json"
    fit_model = read_json(fit_file) if fit_file.exists() else None
    if fit_model and fit_model.get("model") == "fit_prior":
        fit = {
            "model": fit_model,
            "points": [
                {"bucket": b, "h": h, "q": fit_prior_reference(fit_model, b, h)}
                for b in [*fit_model["buckets"].keys(), "unknown_bucket"]
                for h in FIT_POINTS
            ],
        }

    versions = {}
    for name, file in (("confidence", "confidence-model.json"), ("discovery", "discovery-prior.json"), ("fit_prior", "fit-priors.json")):
        path = model_dir() / file
        versions[name] = read_json(path).get("version") if path.exists() else None
    out = Path(args.out)
    write_json(
        out,
        {
            "source": args.source,
            "tolerance": 1e-6,
            "model_versions": versions,
            "models": models,
            "fit_prior": fit,
        },
    )
    print(f"wrote {out}: {', '.join(models)}{' + fit_prior' if fit else ''}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
