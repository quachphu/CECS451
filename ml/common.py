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
