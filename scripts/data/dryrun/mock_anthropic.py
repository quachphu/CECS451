"""Dry run, part 3: a local stand-in for the Anthropic Messages and Message Batches API.

    python3 scripts/data/dryrun/mock_anthropic.py <port>

05_label_teacher.py talks to it through TEACHER_BASE_URL. The mock drafts
a suggestion from the text it is sent (the same sentence forms the synthetic sites
use), with a small seeded error rate, and returns the strict JSON the real
draft returns. The human labels are the ones used. The first request of the first batch comes back "errored" so
the direct-retry path runs too.
"""

from __future__ import annotations

import hashlib
import json
import random
import re
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOM = r"([A-Z][\w' ]+?)"
FORMS = [
    (re.compile(rf"The {ROOM} seats (\d+) guests for a seated dinner and up to (\d+) for a standing reception\."), lambda m: (m[1], int(m[2]), int(m[3]), None)),
    (re.compile(rf"Our {ROOM} accommodates up to (\d+) guests\."), lambda m: (m[1], int(m[2]), None, None)),
    (re.compile(rf"The {ROOM} seats (\d+) guests\."), lambda m: (m[1], int(m[2]), None, None)),
    (re.compile(rf"The {ROOM} holds (\d+) people standing\."), lambda m: (m[1], None, int(m[2]), None)),
    (re.compile(rf"The {ROOM} is ideal for groups of (\d+) to (\d+) guests\."), lambda m: (m[1], int(m[3]), None, int(m[2]))),
    (re.compile(r"For a full buyout, the entire restaurant welcomes up to (\d+) guests\."), lambda m: ("Full buyout", int(m[1]), None, None)),
    (re.compile(rf"The {ROOM} and {ROOM} combine to seat (\d+) guests\."), lambda m: (f"{m[1]}+{m[2]}", int(m[3]), None, None)),
]

BATCHES: dict[str, dict] = {}
LOCK = threading.Lock()
FIRST_BATCH_ERROR = {"done": False}


def label(text: str) -> dict:
    rand = random.Random(hashlib.sha256(text.encode()).hexdigest())
    if "Locations:" in text or "at our locations" in text:
        return {
            "status": "unclear",
            "unclear_reason": "The site describes several locations and does not say which rooms belong to this address.",
            "hosts_private_events": "yes",
            "rooms": [],
            "min_spend_usd": None,
            "total_seats": None,
            "info_maybe_elsewhere": False,
        }
    rooms = []
    seen = set()
    for regex, parse in FORMS:
        for m in regex.finditer(text):
            name, seated, standing, low = parse(m)
            if name in seen:
                continue
            seen.add(name)
            if rand.random() < 0.03:  # draft error: a figure 30% off
                if seated:
                    seated = round(seated * 1.3)
                elif standing:
                    standing = round(standing * 1.3)
            rooms.append({"room_name": name, "seated_max": seated, "standing_max": standing, "min": low, "quote": m[0]})
    total = re.search(r"Our main dining room seats (\d+) guests\.", text)
    links_none = "Event-booking platform links found on the site: none" in text
    events_words = re.search(r"private (events|dining)|group dinners|events team", text, re.I)
    if rooms or events_words or not links_none:
        hosts = "yes"
    elif "We do not take group bookings" in text:
        hosts = "no"
    else:
        hosts = "unknown"
    if hosts == "yes" and rand.random() < 0.015:
        hosts = "unknown"
    return {
        "status": "labeled",
        "unclear_reason": None,
        "hosts_private_events": hosts,
        "rooms": rooms,
        "min_spend_usd": None,
        "total_seats": int(total[1]) if total else None,
        "info_maybe_elsewhere": bool(re.search(r"events packet|\.pdf", text, re.I)),
    }


def message(params: dict) -> dict:
    text = params["messages"][-1]["content"]
    if isinstance(text, list):
        text = " ".join(b.get("text", "") for b in text)
    out = json.dumps(label(text))
    return {
        "id": "msg_dry_" + hashlib.sha256(text.encode()).hexdigest()[:16],
        "type": "message",
        "role": "assistant",
        "model": params["model"],
        "content": [{"type": "text", "text": out}],
        "stop_reason": "end_turn",
        "stop_sequence": None,
        "usage": {
            "input_tokens": len(text) // 4 + 900,
            "output_tokens": len(out) // 3,
            "cache_creation_input_tokens": 0,
            "cache_read_input_tokens": 0,
        },
    }


def batch_view(batch_id: str, base: str) -> dict:
    b = BATCHES[batch_id]
    n = len(b["requests"])
    errored = sum(1 for r in b["results"] if r["result"]["type"] == "errored")
    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    return {
        "id": batch_id,
        "type": "message_batch",
        "processing_status": "ended",
        "request_counts": {"processing": 0, "succeeded": n - errored, "errored": errored, "canceled": 0, "expired": 0},
        "created_at": b["created_at"],
        "ended_at": now,
        "expires_at": now,
        "archived_at": None,
        "cancel_initiated_at": None,
        "results_url": f"{base}/v1/messages/batches/{batch_id}/results",
    }


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):  # quiet
        pass

    def send(self, body, status=200, content_type="application/json"):
        data = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.send_response(status)
        self.send_header("content-type", content_type)
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    @property
    def base(self):
        return f"http://{self.headers.get('host')}"

    def do_POST(self):
        length = int(self.headers.get("content-length") or 0)
        body = json.loads(self.rfile.read(length) or b"{}")
        if self.path.startswith("/v1/messages/batches"):
            with LOCK:
                batch_id = f"msgbatch_dry{len(BATCHES) + 1:04d}"
                results = []
                for i, req in enumerate(body["requests"]):
                    if not FIRST_BATCH_ERROR["done"] and i == 0:
                        FIRST_BATCH_ERROR["done"] = True
                        results.append({"custom_id": req["custom_id"], "result": {"type": "errored", "error": {"type": "error", "error": {"type": "overloaded_error", "message": "dry run"}}}})
                    else:
                        results.append({"custom_id": req["custom_id"], "result": {"type": "succeeded", "message": message(req["params"])}})
                BATCHES[batch_id] = {
                    "requests": body["requests"],
                    "results": results,
                    "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                }
            view = batch_view(batch_id, self.base)
            view["processing_status"] = "in_progress"
            return self.send(view)
        if self.path.startswith("/v1/messages"):
            if "temperature" in body or "top_p" in body:
                return self.send({"type": "error", "error": {"type": "invalid_request_error", "message": "temperature is not supported"}}, 400)
            return self.send(message(body))
        self.send({"type": "error", "error": {"type": "not_found_error", "message": self.path}}, 404)

    def do_GET(self):
        m = re.match(r"^/v1/messages/batches/([\w]+)(/results)?$", self.path.split("?")[0])
        if not m or m[1] not in BATCHES:
            return self.send({"type": "error", "error": {"type": "not_found_error", "message": self.path}}, 404)
        if m[2]:
            lines = "".join(json.dumps(r) + "\n" for r in BATCHES[m[1]]["results"]).encode()
            return self.send(lines, content_type="application/binary")
        self.send(batch_view(m[1], self.base))


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
