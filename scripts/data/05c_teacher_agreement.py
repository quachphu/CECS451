"""Teacher-teacher agreement. Does not report per-item human accuracy or Cohen's kappa.

    python3 scripts/data/05c_teacher_agreement.py

Reads eval/teacher_labels.jsonl (claude-sonnet-5-5) and eval/teacher_labels_opus.jsonl
(claude-opus-5-5, same prompt) and adds the agreement rates to
eval/results/teacher_quality.json.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from ml.common import eval_dir, read_json, read_jsonl, write_json  # noqa: E402


def figures(label: dict) -> list[int]:
    out = []
    for room in label.get("rooms") or []:
        for key in ("seated_max", "standing_max"):
            value = room.get(key)
            if isinstance(value, int) and value > 0:
                out.append(value)
    return out


def matched(reference: list[int], other: list[int]) -> int:
    """How many reference figures have some other figure within 10% of the reference."""
    hits = 0
    for value in reference:
        if any(abs(value - candidate) * 10 <= value for candidate in other):
            hits += 1
    return hits


def main() -> int:
    first = {row["venue_id"]: row for row in read_jsonl(eval_dir("teacher_labels.jsonl"))}
    second_path = eval_dir("teacher_labels_opus.jsonl")
    if not second_path.exists():
        raise SystemExit(f"{second_path} is missing. The second teacher has not finished.")
    second = {row["venue_id"]: row for row in read_jsonl(second_path)}
    shared = sorted(set(first) & set(second))
    hosts = status = 0
    first_figures = second_figures = 0
    first_hits = second_hits = 0
    for venue_id in shared:
        a, b = first[venue_id], second[venue_id]
        hosts += int(a.get("hosts_private_events") == b.get("hosts_private_events"))
        status += int(a.get("status") == b.get("status"))
        fa, fb = figures(a), figures(b)
        first_figures += len(fa)
        second_figures += len(fb)
        first_hits += matched(fa, fb)
        second_hits += matched(fb, fa)
    agreement = {
        "first_teacher": "claude-sonnet-5-5",
        "second_teacher": "claude-opus-5-5",
        "prompt_version": "teacher_v1",
        "venues": len(shared),
        "hosts_private_events_agreement": hosts / len(shared) if shared else None,
        "status_agreement": status / len(shared) if shared else None,
        "sonnet_figures": first_figures,
        "sonnet_figures_within_10pct_of_an_opus_figure": first_hits / first_figures if first_figures else None,
        "opus_figures": second_figures,
        "opus_figures_within_10pct_of_a_sonnet_figure": second_hits / second_figures if second_figures else None,
    }
    quality_path = eval_dir("results", "teacher_quality.json")
    quality = read_json(quality_path) if quality_path.exists() else {}
    quality["teacher_teacher_agreement"] = agreement
    write_json(quality_path, quality)
    print(agreement)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
