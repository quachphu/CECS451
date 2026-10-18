"""Step 5: label every saved venue with Claude (the "teacher") [D-ANT].

    python3 scripts/data/05_label_teacher.py --pilot      # 20 venues, normal API: check prompt and JSON
    python3 scripts/data/05_label_teacher.py --batch      # all remaining venues, Message Batches API (50% off)
    python3 scripts/data/05_label_teacher.py --collect    # re-check a submitted batch and finish

The teacher reads only the snapshot (page text and event links) plus the
venue's name, address and city: never the student's extraction, the regex
output or the app's trust labels. Every quote must appear in the text it was
given (same normalisation as the app's grounding check); a venue whose quotes
don't is retried once on the normal API, then marked "unclear".

Model: TEACHER_MODEL (default claude-sonnet-5-5; claude-opus-5-5 also priced).
Spend cap: ANTHROPIC_BUDGET_USD (default 15), shared ledger eval/.spend/anthropic.json.
Writes eval/teacher_labels.jsonl. Per-venue results are cached in eval/.cache/teacher/.
"""

from __future__ import annotations

import argparse
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from ml.common import (  # noqa: E402
    Budget,
    BudgetExceeded,
    RunManifest,
    eval_dir,
    load_env_local,
    now_iso,
    read_csv,
    read_json,
    write_json,
    write_jsonl,
)
from ml.teacher import (  # noqa: E402
    build_teacher_input,
    clean_label,
    request_params,
    token_cost,
    unsupported_quotes,
    worst_case_cost,
)

PROMPT_VERSION = os.environ.get("TEACHER_PROMPT_VERSION", "teacher_v1")
PILOT_SIZE = 20
MAX_TOKENS = 16_000


def client():
    import anthropic

    key = os.environ.get("ANTHROPIC_API_KEY", "").strip()
    if not key:
        raise SystemExit("Missing ANTHROPIC_API_KEY (environment or .env.local).")
    # Pin the public API: this must not inherit a base URL set for some other tool.
    return anthropic.Anthropic(api_key=key, base_url=os.environ.get("TEACHER_BASE_URL", "https://api.anthropic.com"))


def cache_path(venue_id: str) -> Path:
    return eval_dir(".cache", "teacher", f"{venue_id}.json")


def in_dataset() -> list[dict]:
    rows = read_csv(eval_dir("venue_index.csv"))
    if not rows:
        raise SystemExit(f"{eval_dir('venue_index.csv')} is missing; run 03_snapshot.ts first.")
    return [r for r in rows if r["in_dataset"] == "1"]


def load_input(venue: dict) -> str:
    snapshot = read_json(eval_dir("snapshots", f"{venue['venue_id']}.json"))
    return build_teacher_input(venue, snapshot)


def message_to_label(message, teacher_input: str) -> tuple[dict | None, str | None]:
    """Parses one response. Returns (label, failure_reason)."""
    import json

    if message.stop_reason == "refusal":
        return None, "refusal"
    if message.stop_reason == "max_tokens":
        return None, "max_tokens"
    text = next((b.text for b in message.content if b.type == "text"), "")
    try:
        label = clean_label(json.loads(text))
    except (json.JSONDecodeError, TypeError):
        return None, "invalid_json"
    missing = unsupported_quotes(label, teacher_input)
    if missing:
        return label, f"quote_not_found: {', '.join(missing)}"
    return label, None


def usage_dict(message) -> dict:
    u = message.usage
    return {
        "input_tokens": u.input_tokens,
        "output_tokens": u.output_tokens,
        "cache_creation_input_tokens": getattr(u, "cache_creation_input_tokens", 0) or 0,
        "cache_read_input_tokens": getattr(u, "cache_read_input_tokens", 0) or 0,
    }


def save(venue_id: str, label: dict | None, failure: str | None, usage: dict, cost: float, mode: str, attempts: int, model: str):
    if label is None or failure:
        reason = failure or "no_label"
        label = {
            "status": "unclear",
            "unclear_reason": f"validation_failed: {reason}",
            "hosts_private_events": (label or {}).get("hosts_private_events", "unknown"),
            "rooms": [],
            "min_spend_usd": None,
            "total_seats": (label or {}).get("total_seats"),
            "info_maybe_elsewhere": (label or {}).get("info_maybe_elsewhere", False),
        }
    write_json(
        cache_path(venue_id),
        {
            "label": {"venue_id": venue_id, **label, "teacher_model": model, "prompt_version": PROMPT_VERSION},
            "failure": failure,
            "usage": usage,
            "cost_usd": cost,
            "mode": mode,
            "attempts": attempts,
            "labeled_at": now_iso(),
        },
    )


def label_direct(api, venue: dict, model: str, effort: str, budget: Budget, attempts: int = 1, prior_cost: float = 0.0):
    teacher_input = load_input(venue)
    budget.reserve(worst_case_cost(model, teacher_input, MAX_TOKENS, batch=False))
    message = api.messages.create(**request_params(model, PROMPT_VERSION, teacher_input, effort, MAX_TOKENS))
    usage = usage_dict(message)
    cost = token_cost(model, usage, batch=False)
    budget.charge(cost)
    label, failure = message_to_label(message, teacher_input)
    save(venue["venue_id"], label, failure, usage, prior_cost + cost, "direct", attempts, model)
    return failure


def submit_batch(api, venues: list[dict], model: str, effort: str, budget: Budget) -> str | None:
    from anthropic.types.message_create_params import MessageCreateParamsNonStreaming
    from anthropic.types.messages.batch_create_params import Request

    requests, worst = [], 0.0
    for v in venues:
        teacher_input = load_input(v)
        worst += worst_case_cost(model, teacher_input, MAX_TOKENS, batch=True)
        requests.append(
            Request(
                custom_id=v["venue_id"],
                params=MessageCreateParamsNonStreaming(**request_params(model, PROMPT_VERSION, teacher_input, effort, MAX_TOKENS)),
            )
        )
    if not requests:
        return None
    budget.reserve(worst)
    batch = api.messages.batches.create(requests=requests)
    state = read_json(eval_dir(".cache", "teacher", "batches.json")) if eval_dir(".cache", "teacher", "batches.json").exists() else []
    state.append({"batch_id": batch.id, "venue_ids": [v["venue_id"] for v in venues], "submitted_at": now_iso(), "collected": False})
    write_json(eval_dir(".cache", "teacher", "batches.json"), state)
    print(f"Submitted batch {batch.id} with {len(requests)} venues.")
    return batch.id


def collect_batches(api, venues_by_id: dict, model: str, effort: str, budget: Budget, wait: bool) -> list[str]:
    """Polls submitted batches; saves results; returns venue ids that need a direct retry."""
    state_file = eval_dir(".cache", "teacher", "batches.json")
    state = read_json(state_file) if state_file.exists() else []
    retry: list[str] = []
    for entry in state:
        if entry["collected"]:
            continue
        while True:
            batch = api.messages.batches.retrieve(entry["batch_id"])
            if batch.processing_status == "ended" or not wait:
                break
            counts = batch.request_counts
            print(f"Batch {entry['batch_id']}: processing {counts.processing}, succeeded {counts.succeeded}. Waiting 60 s.")
            time.sleep(60)
        if batch.processing_status != "ended":
            print(f"Batch {entry['batch_id']} still {batch.processing_status}; rerun with --collect later.")
            continue
        for result in api.messages.batches.results(entry["batch_id"]):
            venue = venues_by_id.get(result.custom_id)
            if venue is None:
                continue
            if result.result.type == "succeeded":
                message = result.result.message
                usage = usage_dict(message)
                cost = token_cost(model, usage, batch=True)
                budget.charge(cost)
                teacher_input = load_input(venue)
                label, failure = message_to_label(message, teacher_input)
                save(venue["venue_id"], label, failure, usage, cost, "batch", 1, model)
                if failure:
                    retry.append(venue["venue_id"])
            else:
                retry.append(venue["venue_id"])  # errored / canceled / expired: retry directly
        entry["collected"] = True
        write_json(state_file, state)
    return retry


def assemble(venues: list[dict], manifest: RunManifest) -> None:
    labels = []
    for v in venues:
        path = cache_path(v["venue_id"])
        if path.exists():
            cached = read_json(path)
            labels.append(cached["label"])
            manifest.count(f"status_{cached['label']['status']}")
            manifest.count(f"hosts_{cached['label']['hosts_private_events']}")
            manifest.count("rooms", len(cached["label"]["rooms"]))
            if cached.get("failure"):
                manifest.count("validation_failed")
    out = eval_dir("teacher_labels.jsonl")
    write_jsonl(out, labels)
    manifest.counts["venues_labeled_or_unclear"] = len(labels)
    manifest.counts["venues_pending"] = len(venues) - len(labels)
    manifest.outputs.append(out)


def main() -> None:
    load_env_local()
    parser = argparse.ArgumentParser()
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--pilot", action="store_true")
    mode.add_argument("--batch", action="store_true")
    mode.add_argument("--collect", action="store_true")
    parser.add_argument("--limit", type=int, default=None)
    parser.add_argument("--no-wait", action="store_true", help="submit or check once, without waiting for the batch")
    args = parser.parse_args()

    model = os.environ.get("TEACHER_MODEL", "claude-sonnet-5-5")
    effort = os.environ.get("TEACHER_EFFORT", "medium")
    budget = Budget("anthropic", "usd", float(os.environ.get("ANTHROPIC_BUDGET_USD", 15)))
    manifest = RunManifest("05_label_teacher:" + ("pilot" if args.pilot else "batch" if args.batch else "collect"))
    manifest.models.update({"teacher": model, "prompt_version": PROMPT_VERSION, "effort": effort})
    manifest.inputs.append(eval_dir("venue_index.csv"))

    venues = in_dataset()
    by_id = {v["venue_id"]: v for v in venues}
    todo = [v for v in venues if not cache_path(v["venue_id"]).exists()]
    if args.limit is not None:
        todo = todo[: args.limit]
    api = client()
    status = "ok"
    try:
        if args.pilot:
            for v in todo[:PILOT_SIZE]:
                failure = label_direct(api, v, model, effort, budget)
                if failure and failure.startswith("quote_not_found"):
                    failure = label_direct(api, v, model, effort, budget, attempts=2)
                print(f"{v['venue_id']}: {'ok' if not failure else failure}")
        else:
            pending = {vid for e in (read_json(eval_dir('.cache', 'teacher', 'batches.json')) if eval_dir('.cache', 'teacher', 'batches.json').exists() else []) if not e["collected"] for vid in e["venue_ids"]}
            if args.batch:
                submit_batch(api, [v for v in todo if v["venue_id"] not in pending], model, effort, budget)
            retry = collect_batches(api, by_id, model, effort, budget, wait=not args.no_wait)
            for vid in retry:
                failure = label_direct(api, by_id[vid], model, effort, budget, attempts=2)
                print(f"retry {vid}: {'ok' if not failure else failure}")
    except BudgetExceeded as err:
        status = "aborted_budget"
        print(f"{err}. Progress is saved.")
    finally:
        assemble(venues, manifest)
        manifest.spend["anthropic_usd_total"] = round(budget.spent, 4)
        manifest.write(status)
    print(f"Anthropic spend so far: ${budget.spent:.2f} of ${budget.cap}. Labels: {eval_dir('teacher_labels.jsonl')}")


if __name__ == "__main__":
    main()
