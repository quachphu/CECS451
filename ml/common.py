"""Shared helpers for the offline training pipeline (scripts/data/*.py and ml/).

Paths and ledgers mirror scripts/data/lib/{io,budget,manifest}.ts so the
TypeScript and Python steps write one run manifest and share spend caps.
"""

from __future__ import annotations

import csv
import hashlib
import json
import os
import subprocess
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

REPO = Path(__file__).resolve().parents[1]
SEED = 451


def eval_dir(*parts: str) -> Path:
    """eval/ (or TRAINING_EVAL_DIR for a dry run), relative to the repository root."""
    base = os.environ.get("TRAINING_EVAL_DIR", "").strip() or "eval"
    root = Path(base) if Path(base).is_absolute() else REPO / base
    return root.joinpath(*parts)


def model_dir() -> Path:
    """Where trained model JSON goes: src/data/, or MODEL_EXPORT_DIR (a dry run must not overwrite the app's models)."""
    base = os.environ.get("MODEL_EXPORT_DIR", "").strip()
    return (Path(base) if Path(base).is_absolute() else REPO / base) if base else REPO / "src" / "data"


def load_env_local() -> None:
    """Loads .env.local into os.environ without overriding values already set."""
    for name in (".env.local", ".env"):
        path = REPO / name
        if not path.exists():
            continue
        for line in path.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


# ------------------------------------------------------------------- files

def write_atomic(path: Path, data: str | bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    mode = "wb" if isinstance(data, bytes) else "w"
    with tempfile.NamedTemporaryFile(mode, dir=path.parent, delete=False, suffix=".tmp") as tmp:
        tmp.write(data)
        tmp_name = tmp.name
    os.chmod(tmp_name, 0o644)  # NamedTemporaryFile creates 0600
    os.replace(tmp_name, path)


def write_json(path: Path, value: Any) -> None:
    write_atomic(path, json.dumps(value, indent=2, ensure_ascii=False) + "\n")


def read_json(path: Path) -> Any:
    return json.loads(path.read_text())


def read_jsonl(path: Path) -> list[dict]:
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def write_jsonl(path: Path, rows: Iterable[dict]) -> None:
    write_atomic(path, "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows))


def read_csv(path: Path) -> list[dict[str, str]]:
    if not path.exists():
        return []
    with path.open(newline="", encoding="utf-8-sig") as fh:
        return list(csv.DictReader(fh))


def sha256_file(path: Path) -> str | None:
    return hashlib.sha256(path.read_bytes()).hexdigest() if path.exists() else None


# ----------------------------------------------------------------- manifest

def git_sha() -> str | None:
    try:
        return subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=REPO, stderr=subprocess.DEVNULL).decode().strip()
    except Exception:
        return None


class RunManifest:
    """One line per run in eval/run_manifest.jsonl (same shape as the TypeScript manifest)."""

    def __init__(self, script: str):
        self.script = script
        self.started_at = now_iso()
        self.models: dict[str, str] = {}
        self.counts: dict[str, float] = {}
        self.spend: dict[str, float] = {}
        self.inputs: list[Path] = []
        self.outputs: list[Path] = []
        self.notes: str | None = None

    def count(self, key: str, by: float = 1) -> None:
        self.counts[key] = self.counts.get(key, 0) + by

    def write(self, status: str = "ok") -> dict:
        entry = {
            "script": self.script,
            "git_sha": git_sha(),
            "started_at": self.started_at,
            "ended_at": now_iso(),
            "models": self.models,
            "counts": self.counts,
            "spend": self.spend,
            "inputs": {str(p): sha256_file(p) for p in self.inputs},
            "outputs": {str(p): sha256_file(p) for p in self.outputs},
            "status": status,
            **({"notes": self.notes} if self.notes else {}),
        }
        path = eval_dir("run_manifest.jsonl")
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a") as fh:
            fh.write(json.dumps(entry) + "\n")
        return entry


# ------------------------------------------------------------------- budget

class BudgetExceeded(RuntimeError):
    pass


class Budget:
    """Spend ledger in eval/.spend/<service>.json, shared with scripts/data/lib/budget.ts."""

    def __init__(self, service: str, unit: str, cap: float):
        self.path = eval_dir(".spend", f"{service}.json")
        saved = read_json(self.path) if self.path.exists() else {}
        self.ledger = {
            "service": service,
            "unit": unit,
            "cap": cap,
            "spent": float(saved.get("spent", 0)),
            "calls": int(saved.get("calls", 0)),
            "updated_at": saved.get("updated_at", ""),
        }

    @property
    def spent(self) -> float:
        return self.ledger["spent"]

    @property
    def cap(self) -> float:
        return self.ledger["cap"]

    def reserve(self, worst_case: float) -> None:
        if self.spent + worst_case > self.cap:
            raise BudgetExceeded(f"{self.ledger['service']} budget reached: {self.spent:.4f} of {self.cap} spent")

    def charge(self, amount: float) -> None:
        self.ledger["spent"] += amount
        self.ledger["calls"] += 1
        self.ledger["updated_at"] = now_iso()
        write_json(self.path, self.ledger)


# ================================================================= modeling
# Calibration metrics [P4, P5], grouped bootstrap, the logistic pipeline and
# its JSON export. Imports are local so the labeling script stays light.

H_EPS = 1e-15


def _arrays(y, p):
    import numpy as np

    return np.asarray(y, dtype=float), np.clip(np.asarray(p, dtype=float), H_EPS, 1 - H_EPS)


def log_loss(y, p) -> float:
    import numpy as np

    y, p = _arrays(y, p)
    return float(-np.mean(y * np.log(p) + (1 - y) * np.log(1 - p)))


def brier(y, p) -> float:
    import numpy as np

    y, p = _arrays(y, p)
    return float(np.mean((p - y) ** 2))


def roc_auc(y, p) -> float | None:
    """Mann-Whitney AUC with average ranks for ties; None when only one class is present."""
    import numpy as np
    from scipy.stats import rankdata

    y, p = np.asarray(y, dtype=float), np.asarray(p, dtype=float)
    pos = int(y.sum())
    neg = len(y) - pos
    if pos == 0 or neg == 0:
        return None
    ranks = rankdata(p)
    return float((ranks[y == 1].sum() - pos * (pos + 1) / 2) / (pos * neg))


def ece(y, p, n_bins: int = 10, strategy: str = "width") -> float:
    """Expected calibration error [P5]. strategy="width": 10 equal-width bins on [0, 1]
    (bin b holds (b/n, (b+1)/n], with 0 in the first); "mass": equal-count bins by rank."""
    import numpy as np

    y = np.asarray(y, dtype=float)
    p = np.asarray(p, dtype=float)
    n = len(p)
    if n == 0:
        return float("nan")
    if strategy == "width":
        idx = np.clip(np.ceil(p * n_bins).astype(int) - 1, 0, n_bins - 1)
    elif strategy == "mass":
        order = np.argsort(p, kind="stable")
        idx = np.empty(n, dtype=int)
        idx[order] = (np.arange(n) * n_bins) // n
    else:
        raise ValueError(strategy)
    total = 0.0
    for b in range(n_bins):
        m = idx == b
        if m.any():
            total += m.sum() / n * abs(y[m].mean() - p[m].mean())
    return float(total)


def classification_metrics(y, p) -> dict:
    import numpy as np

    y = np.asarray(y, dtype=float)
    p = np.asarray(p, dtype=float)
    return {
        "n": int(len(y)),
        "positives": int(y.sum()),
        "log_loss": log_loss(y, p) if len(y) else None,
        "brier": brier(y, p) if len(y) else None,
        "auc": roc_auc(y, p),
        "ece_width": ece(y, p, strategy="width") if len(y) else None,
        "ece_mass": ece(y, p, strategy="mass") if len(y) else None,
        "accuracy": float(np.mean((p >= 0.5) == (y == 1))) if len(y) else None,
    }


def bootstrap_ci(y, p, groups, n_resamples: int = 1000, seed: int = SEED, level: float = 0.95) -> dict:
    """Percentile CIs for each metric, resampling whole groups (website domains) with replacement."""
    import numpy as np

    y = np.asarray(y, dtype=float)
    p = np.asarray(p, dtype=float)
    groups = np.asarray(groups)
    if len(y) == 0:
        return {}
    uniq, inverse = np.unique(groups, return_inverse=True)
    members = [np.flatnonzero(inverse == g) for g in range(len(uniq))]
    rng = np.random.default_rng(seed)
    keys = ["log_loss", "brier", "auc", "ece_width", "ece_mass", "accuracy"]
    draws: dict[str, list[float]] = {k: [] for k in keys}
    for _ in range(n_resamples):
        pick = rng.integers(0, len(uniq), len(uniq))
        rows = np.concatenate([members[g] for g in pick])
        yy, pp = y[rows], p[rows]
        draws["log_loss"].append(log_loss(yy, pp))
        draws["brier"].append(brier(yy, pp))
        a = roc_auc(yy, pp)
        if a is not None:
            draws["auc"].append(a)
        draws["ece_width"].append(ece(yy, pp, strategy="width"))
        draws["ece_mass"].append(ece(yy, pp, strategy="mass"))
        draws["accuracy"].append(float(np.mean((pp >= 0.5) == (yy == 1))))
    lo, hi = (1 - level) / 2 * 100, (1 + level) / 2 * 100
    return {k: [float(np.percentile(v, lo)), float(np.percentile(v, hi))] if v else None for k, v in draws.items()}


def metrics_with_ci(y, p, groups, n_resamples: int = 1000) -> dict:
    out = classification_metrics(y, p)
    out["ci95"] = bootstrap_ci(y, p, groups, n_resamples)
    return out


def reliability_diagram(curves: dict, path: Path, title: str, n_bins: int = 10) -> None:
    """Reliability diagram [P4]: observed frequency vs. mean predicted probability per equal-width bin."""
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    import numpy as np

    fig, ax = plt.subplots(figsize=(5, 5))
    ax.plot([0, 1], [0, 1], linestyle="--", color="grey", linewidth=1, label="perfect")
    for label, (y, p) in curves.items():
        y = np.asarray(y, dtype=float)
        p = np.asarray(p, dtype=float)
        if len(y) == 0:
            continue
        idx = np.clip(np.ceil(p * n_bins).astype(int) - 1, 0, n_bins - 1)
        xs, ys, ns = [], [], []
        for b in range(n_bins):
            m = idx == b
            if m.any():
                xs.append(p[m].mean())
                ys.append(y[m].mean())
                ns.append(int(m.sum()))
        ax.plot(xs, ys, marker="o", label=f"{label} (n={len(y)})")
    ax.set_xlim(0, 1)
    ax.set_ylim(0, 1)
    ax.set_xlabel("Predicted probability")
    ax.set_ylabel("Observed frequency")
    ax.set_title(title)
    ax.legend(loc="upper left", fontsize=8)
    fig.tight_layout()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp.png")
    fig.savefig(tmp, dpi=120)
    plt.close(fig)
    os.replace(tmp, path)


# ---------------------------------------------------------------- pipeline

C_GRID = [0.01, 0.03, 0.1, 0.3, 1, 3, 10]


def build_pipeline(features: list[str], scale_cols: list[str], C: float, class_weight=None):
    """Median imputation, z-scaling of `scale_cols` only (binary columns pass through), L2 logistic regression [D9]."""
    from sklearn.compose import ColumnTransformer
    from sklearn.impute import SimpleImputer
    from sklearn.linear_model import LogisticRegression
    from sklearn.pipeline import Pipeline
    from sklearn.preprocessing import StandardScaler

    scale_idx = [features.index(c) for c in scale_cols if c in features]
    pass_idx = [i for i in range(len(features)) if i not in scale_idx]
    return Pipeline(
        [
            ("impute", SimpleImputer(strategy="median", keep_empty_features=True)),
            (
                "scale",
                ColumnTransformer(
                    [("z", StandardScaler(), scale_idx), ("keep", "passthrough", pass_idx)],
                    sparse_threshold=0,
                ),
            ),
            # l1_ratio=0 is L2; scikit-learn 1.8 deprecated penalty="l2".
            ("lr", LogisticRegression(C=C, l1_ratio=0.0, solver="lbfgs", max_iter=1000, class_weight=class_weight)),
        ]
    )


def group_folds(y, groups, n_splits: int = 5, seed: int = SEED) -> list:
    """StratifiedGroupKFold splits [D9b], with fewer folds when there are fewer domains or minority rows."""
    import warnings

    import numpy as np
    from sklearn.model_selection import StratifiedGroupKFold

    y = np.asarray(y)
    k = int(min(n_splits, len(set(groups)), max(2, min(int(y.sum()), int(len(y) - y.sum())))))
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", UserWarning)  # "least populated class" on tiny data
        return list(StratifiedGroupKFold(n_splits=k, shuffle=True, random_state=seed).split(np.zeros(len(y)), y, groups))


def oof_predict(make_model, X, y, folds) -> "np.ndarray":
    """Out-of-fold probabilities; a fold whose training part has one class predicts that class's rate."""
    import numpy as np

    X = np.asarray(X, dtype=float)
    y = np.asarray(y, dtype=int)
    out = np.zeros(len(y), dtype=float)
    for tr, te in folds:
        if len(set(y[tr])) < 2:
            out[te] = float(y[tr].mean())
            continue
        model = make_model()
        model.fit(X[tr], y[tr])
        out[te] = model.predict_proba(X[te])[:, 1]
    return out


def select_C(X, y, folds, features, scale_cols, class_weight=None, grid=C_GRID) -> tuple[float, dict, "np.ndarray"]:
    """Picks C by mean out-of-fold log loss (not accuracy). Returns (C, {C: log loss}, OOF probabilities at C)."""
    import numpy as np

    scores, preds = {}, {}
    for C in grid:
        p = oof_predict(lambda: build_pipeline(features, scale_cols, C, class_weight), X, y, folds)
        fold_losses = [log_loss(np.asarray(y)[te], p[te]) for _, te in folds]
        scores[C] = float(np.mean(fold_losses))
        preds[C] = p
    best = min(grid, key=lambda c: (scores[c], c))  # ties go to the stronger penalty
    return best, scores, preds[best]


def export_logistic(pipe, features: list[str], scale_cols: list[str]) -> dict:
    """The fitted pipeline as plain numbers: medians, scaler, coefficients in `features` order."""
    imputer = pipe.named_steps["impute"]
    ct = pipe.named_steps["scale"]
    lr = pipe.named_steps["lr"]
    scale_idx = [features.index(c) for c in scale_cols if c in features]
    pass_idx = [i for i in range(len(features)) if i not in scale_idx]
    out_order = [features[i] for i in scale_idx] + [features[i] for i in pass_idx]
    coef_by_name = dict(zip(out_order, [float(c) for c in lr.coef_[0]]))
    scaler = ct.named_transformers_["z"] if scale_idx else None
    return {
        "feature_order": list(features),
        "impute_median": {f: float(m) for f, m in zip(features, imputer.statistics_)},
        "scaler": {
            features[i]: {"mean": float(scaler.mean_[j]), "std": float(scaler.scale_[j])} for j, i in enumerate(scale_idx)
        }
        if scaler is not None
        else {},
        "coef": [coef_by_name[f] for f in features],
        "intercept": float(lr.intercept_[0]),
        "calibration": None,
    }


def score_exported(model: dict, X) -> "np.ndarray":
    """Scores rows with an exported model exactly as model-scoring.ts does (the parity reference)."""
    import numpy as np

    X = np.asarray(X, dtype=float).copy()
    feats = model["feature_order"]
    for j, f in enumerate(feats):
        col = X[:, j]
        col[np.isnan(col)] = model["impute_median"][f]
        if f in model["scaler"]:
            s = model["scaler"][f]
            col[:] = (col - s["mean"]) / s["std"]
    z = X @ np.asarray(model["coef"], dtype=float) + model["intercept"]
    cal = model.get("calibration")
    if cal:
        return 1 / (1 + np.exp(cal["a"] * z + cal["b"]))
    return 1 / (1 + np.exp(-z))


def odds_sentence(feature: str, coef: float, scaled: dict | None) -> str:
    """Plain-English reading of one coefficient, e.g. "grounded = 1 multiplies the odds by 3.10."."""
    import math

    ratio = math.exp(coef)
    if scaled:
        return f"One standard deviation more {feature} ({scaled['std']:.3g}) multiplies the odds by {ratio:.2f}."
    return f"{feature} = 1 multiplies the odds by {ratio:.2f}."


# ------------------------------------------------------------------ tables

def load_table(name: str):
    import pandas as pd

    path = eval_dir(name)
    if not path.exists():
        raise FileNotFoundError(f"{path} is missing; run scripts/data/08_build_tables.ts first.")
    return pd.read_csv(path, dtype={"venue_id": str, "domain": str, "city": str, "bucket": str, "split": str})


def columns_between(df, start: str, end: str | None) -> list[str]:
    """Feature columns as the TypeScript wrote them: everything after `start` (and before `end`)."""
    cols = list(df.columns)
    i = cols.index(start) + 1
    j = cols.index(end) if end else len(cols)
    return cols[i:j]


def gold_ids() -> set[str]:
    return {r["venue_id"] for r in read_csv(eval_dir("gold_venues.csv"))}


class LeakageError(AssertionError):
    pass


def assert_no_leakage(train, test, gold: set[str]) -> None:
    """No gold venue, no LA venue and no test domain in a training frame."""
    bad_gold = set(train["venue_id"]) & gold
    if bad_gold:
        raise LeakageError(f"gold venues in training data: {sorted(bad_gold)[:5]}")
    if (train["city"] == "LA").any():
        raise LeakageError("LA venues in training data")
    shared = set(train["domain"]) & set(test["domain"])
    if shared:
        raise LeakageError(f"domains in both train and test: {sorted(shared)[:5]}")
    if "split" in train and (train["split"] != "train").any():
        raise LeakageError("non-train split rows in training data")


def test_subsets(test) -> dict:
    """The named test sets: all gold, LA gold, and the rest of LA. The split id is test_la_teacher; the labels are the human labels."""
    return {
        "test_gold": test[test["split"] == "test_gold"],
        "test_la_gold": test[(test["split"] == "test_gold") & (test["city"] == "LA")],
        "test_la_teacher": test[test["split"] == "test_la_teacher"],
    }


def model_version() -> str:
    return "trained-" + datetime.now(timezone.utc).strftime("%Y-%m-%d")


# ------------------------------------------------------------------ parity

PARITY_ROWS = 30


def write_parity(name: str, model: dict, frame, features: list[str], proba) -> Path:
    """Saves PARITY_ROWS rows and scikit-learn's predict_proba for them, for the TypeScript parity test.
    Missing values are kept as null so the TypeScript side exercises imputation too."""
    import math

    import numpy as np

    n = len(frame)
    rng = np.random.default_rng(SEED)
    pick = sorted(rng.choice(n, size=min(PARITY_ROWS, n), replace=False).tolist()) if n else []
    rows = []
    for i in pick:
        x = {}
        for f in features:
            v = frame.iloc[i][f]
            x[f] = None if v is None or (isinstance(v, float) and math.isnan(v)) else float(v)
        rows.append({"x": x, "p": float(proba[i])})
    path = eval_dir("results", "parity", f"{name}.json")
    write_json(path, {"name": name, "model": model, "rows": rows})
    return path
