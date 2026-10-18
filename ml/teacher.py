"""Teacher labeling helpers (Step 5): input, schema, validation and cost.

The teacher must never see the student's output. `build_teacher_input` reads
only the venue's name/address/city and the snapshot's pages and event links;
it rejects any other source by construction (see test_teacher.py).
"""

from __future__ import annotations

import os
from pathlib import Path

from ml.grounding import quote_found

PROMPT_DIR = Path(__file__).resolve().parent / "prompts"
MAX_INPUT_CHARS = 60_000
PAGE_ORDER = {"private_dining": 0, "other": 1, "pdf": 2, "homepage": 3}

# Snapshot fields the teacher may read; everything else in a snapshot is ignored.
SNAPSHOT_FIELDS_USED = ("pages", "external_event_links", "website")

TEACHER_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": [
        "status",
        "unclear_reason",
        "hosts_private_events",
        "rooms",
        "min_spend_usd",
        "total_seats",
        "info_maybe_elsewhere",
    ],
    "properties": {
        "status": {"type": "string", "enum": ["labeled", "unclear"]},
        "unclear_reason": {"anyOf": [{"type": "string"}, {"type": "null"}]},
        "hosts_private_events": {"type": "string", "enum": ["yes", "no", "unknown"]},
        "rooms": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["room_name", "seated_max", "standing_max", "min", "quote"],
                "properties": {
                    "room_name": {"type": "string"},
                    "seated_max": {"anyOf": [{"type": "integer"}, {"type": "null"}]},
                    "standing_max": {"anyOf": [{"type": "integer"}, {"type": "null"}]},
                    "min": {"anyOf": [{"type": "integer"}, {"type": "null"}]},
                    "quote": {"type": "string"},
                },
            },
        },
        "min_spend_usd": {"anyOf": [{"type": "integer"}, {"type": "null"}]},
        "total_seats": {"anyOf": [{"type": "integer"}, {"type": "null"}]},
        "info_maybe_elsewhere": {"type": "boolean"},
    },
}

# Standard per-million-token prices; the Batches API halves them. Overridable via env.
PRICES = {
    "claude-sonnet-5-5": (2.00, 10.00),
    "claude-opus-5-5": (4.00, 20.00),
}


def prompt_text(version: str) -> str:
    return (PROMPT_DIR / f"{version}.md").read_text()


def ordered_pages(snapshot: dict) -> list[dict]:
    pages = [p for p in snapshot.get("pages", []) if p.get("text")]
    return sorted(pages, key=lambda p: PAGE_ORDER.get(p.get("kind", "other"), 1))


def build_teacher_input(venue: dict, snapshot: dict, max_chars: int = MAX_INPUT_CHARS) -> str:
    """Venue facts plus page text, private-dining pages first, at most `max_chars` of page text.

    Over the limit, the homepage is cut first, then the last pages. Only
    SNAPSHOT_FIELDS_USED are read from the snapshot.
    """
    pages = ordered_pages(snapshot)
    texts = [p["text"] for p in pages]
    over = sum(len(t) for t in texts) - max_chars
    for i in reversed(range(len(pages))):  # homepage is last in PAGE_ORDER
        if over <= 0:
            break
        cut = min(over, len(texts[i]))
        texts[i] = texts[i][: len(texts[i]) - cut]
        over -= cut

    links = snapshot.get("external_event_links") or []
    parts = [
        f"Venue: {venue['name']}",
        f"Address: {venue['address']}",
        f"City: {venue['city']}",
        f"Website: {snapshot.get('website') or ''}",
        "",
        "Event-booking platform links found on the site: " + (", ".join(links) if links else "none"),
        "",
    ]
    for i, (page, text) in enumerate(zip(pages, texts), start=1):
        if not text:
            continue
        parts.append(f"=== Page {i} ({page.get('kind', 'other')}): {page.get('url', '')} ===")
        parts.append(text)
        parts.append("")
    return "\n".join(parts)


def page_text_only(teacher_input: str) -> str:
    return teacher_input


def request_params(model: str, version: str, teacher_input: str, effort: str, max_tokens: int = 16000) -> dict:
    return {
        "model": model,
        "max_tokens": max_tokens,
        "system": prompt_text(version),
        "messages": [{"role": "user", "content": teacher_input}],
        "output_config": {"effort": effort, "format": {"type": "json_schema", "schema": TEACHER_SCHEMA}},
    }


def unsupported_quotes(label: dict, teacher_input: str) -> list[str]:
    """Room quotes not found in the text the teacher was given (same normalisation as grounding)."""
    return [r.get("room_name", "") for r in label.get("rooms", []) if not quote_found(r.get("quote"), teacher_input)]


def clean_label(label: dict) -> dict:
    """Drops non-positive figures and minimums above the maximum; keeps everything else as given."""
    def pos(v):
        return v if isinstance(v, int) and v > 0 else None

    rooms = []
    for r in label.get("rooms", []):
        seated, standing, low = pos(r.get("seated_max")), pos(r.get("standing_max")), pos(r.get("min"))
        top = max([v for v in (seated, standing) if v is not None], default=None)
        if low is not None and top is not None and low > top:
            low = None
        rooms.append({**r, "seated_max": seated, "standing_max": standing, "min": low})
    return {
        **label,
        "rooms": rooms,
        "min_spend_usd": pos(label.get("min_spend_usd")),
        "total_seats": pos(label.get("total_seats")),
    }


def token_cost(model: str, usage: dict, batch: bool) -> float:
    default_in, default_out = PRICES.get(model, PRICES["claude-opus-5-5"])
    price_in = float(os.environ.get("TEACHER_PRICE_INPUT_PER_M", default_in)) / 1e6
    price_out = float(os.environ.get("TEACHER_PRICE_OUTPUT_PER_M", default_out)) / 1e6
    tokens_in = (usage.get("input_tokens") or 0) + (usage.get("cache_creation_input_tokens") or 0) * 1.25 + (
        usage.get("cache_read_input_tokens") or 0
    ) * 0.1
    cost = tokens_in * price_in + (usage.get("output_tokens") or 0) * price_out
    return cost * (0.5 if batch else 1.0)


def worst_case_cost(model: str, teacher_input: str, max_tokens: int, batch: bool) -> float:
    est_input_tokens = len(teacher_input) / 3 + 2_000  # page text plus the prompt
    return token_cost(model, {"input_tokens": est_input_tokens, "output_tokens": max_tokens}, batch)
