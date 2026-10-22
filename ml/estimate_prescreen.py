"""Cost of a top-up that pays Grok and Claude only for pages with event content.

    .venv/bin/python ml/estimate_prescreen.py

No network. Google and the snapshot still run on every sampled venue, because
that is how event content is known. Extraction and the support draft then run only
on the readable pages that have a private-dining page, event wording, or an
external event link.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pandas as pd

from ml.common import eval_dir, read_jsonl, write_json

# Observed totals from the collection already on disk.
INDEXED = 655
GROK_USD = 9.25
CLAUDE_USD = 1.79
FIRECRAWL_CREDITS = 49
GOOGLE_CALLS_USED = 655
GOOGLE_CALLS_LEFT = 245
TARGET_TRAIN_VENUES = 60


def has_room(label: dict) -> bool:
    for room in label.get("rooms") or []:
        for key in ("seated_max", "standing_max"):
            value = room.get(key)
            if isinstance(value, int) and value > 0:
                return True
    return False


def main() -> int:
    event = pd.concat(
        [pd.read_csv(eval_dir("train_discovery_event.csv")), pd.read_csv(eval_dir("test_discovery_event.csv"))],
        ignore_index=True,
    )
    rooms = {row["venue_id"] for row in read_jsonl(eval_dir("teacher_labels.jsonl")) if has_room(row)}
    event_ids = set(event.loc[event["y"] == 1, "venue_id"])
    ok = int(len(event))
    event_n = len(event_ids)
    rooms_n = len(rooms)
    rooms_in_event = len(rooms & event_ids)
    train_rooms = int(event.loc[(event["split"] == "train") & event["venue_id"].isin(rooms), "venue_id"].nunique())
    needed = max(0, TARGET_TRAIN_VENUES - train_rooms)

    ok_rate = ok / INDEXED
    event_rate = event_n / ok
    room_given_event = rooms_in_event / event_n if event_n else 0
    room_given_ok = rooms_n / ok if ok else 0
    per_ok_grok = GROK_USD / ok
    per_ok_claude = CLAUDE_USD / ok

    def cost(sampled: float, prescreen: bool) -> dict:
        readable = sampled * ok_rate
        labeled = readable * event_rate if prescreen else readable
        return {
            "sampled_venues": round(sampled),
            "expected_readable": round(readable),
            "expected_labeled": round(labeled),
            "expected_new_room_venues": round(labeled * (room_given_event if prescreen else room_given_ok)),
            "grok_usd": round(labeled * per_ok_grok, 2),
            "claude_usd": round(labeled * per_ok_claude, 2),
            "firecrawl_credits": round(sampled / INDEXED * FIRECRAWL_CREDITS),
            "google_calls": round(sampled),
            "google_calls_past_free_cap": max(0, round(sampled) - GOOGLE_CALLS_LEFT),
        }

    screened_sample = needed / (ok_rate * event_rate * room_given_event) if room_given_event else None
    open_sample = needed / (ok_rate * room_given_ok) if room_given_ok else None
    report = {
        "target_train_venues_with_a_room": TARGET_TRAIN_VENUES,
        "train_venues_with_a_room_now": train_rooms,
        "venues_still_needed": needed,
        "ok_pages": ok,
        "event_content_pages": event_n,
        "pages_with_a_teacher_room": rooms_n,
        "event_pages_with_a_teacher_room": rooms_in_event,
        "room_rate_given_event_content": round(room_given_event, 3),
        "room_rate_given_readable": round(room_given_ok, 3),
        "prescreen_to_60": None if screened_sample is None else cost(screened_sample, True),
        "no_prescreen_to_60": None if open_sample is None else cost(open_sample, False),
        "prescreen_300_nyc_sf_honolulu": cost(300, True),
        "note": "Prescreen still pays Google and the snapshot for every sampled venue. Grok and Claude run only when the saved page has event content. This pass spends nothing.",
    }
    write_json(eval_dir("results", "topup_prescreen.json"), report)
    print(report)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
