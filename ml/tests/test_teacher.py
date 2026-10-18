import ast
from pathlib import Path

from ml.teacher import (
    MAX_INPUT_CHARS,
    TEACHER_SCHEMA,
    build_teacher_input,
    clean_label,
    request_params,
    token_cost,
    unsupported_quotes,
)

VENUE = {"venue_id": "sf-0001", "name": "Example Grill", "address": "1 Main St", "city": "SF"}
SNAPSHOT = {
    "venue_id": "sf-0001",
    "website": "https://examplegrill.com",
    "pages": [
        {"url": "https://examplegrill.com", "kind": "homepage", "text": "Welcome home. " * 10},
        {"url": "https://examplegrill.com/events", "kind": "private_dining", "text": "The Garden Room seats 40 guests."},
    ],
    "external_event_links": ["https://www.tripleseat.com/party/1"],
}


def test_private_dining_pages_come_first_and_links_are_listed():
    text = build_teacher_input(VENUE, SNAPSHOT)
    assert text.index("The Garden Room seats 40 guests.") < text.index("Welcome home.")
    assert "https://www.tripleseat.com/party/1" in text
    assert "Venue: Example Grill" in text


def test_the_homepage_is_cut_first_when_over_the_limit():
    long_home = {**SNAPSHOT, "pages": [
        {"url": "h", "kind": "homepage", "text": "H" * (MAX_INPUT_CHARS + 500)},
        {"url": "p", "kind": "private_dining", "text": "P" * 1000},
    ]}
    text = build_teacher_input(VENUE, long_home)
    assert text.count("P") >= 1000
    assert text.count("H") == MAX_INPUT_CHARS - 1000


def test_the_teacher_never_sees_student_output():
    poisoned = {**SNAPSHOT, "extraction": {"rooms": [{"roomName": "SECRET STUDENT ROOM", "maxCapacity": 999}]},
                "trust": "verified", "regex": [999]}
    text = build_teacher_input(VENUE, poisoned)
    assert "SECRET STUDENT ROOM" not in text and "999" not in text and "verified" not in text


def test_the_labeling_script_never_reads_student_files():
    source = (Path(__file__).resolve().parents[2] / "scripts/data/05_label_teacher.py").read_text()
    tree = ast.parse(source)
    strings = [n.value for n in ast.walk(tree) if isinstance(n, ast.Constant) and isinstance(n.value, str)]
    student_files = ("extractions.jsonl", "extraction_venues", "student")
    paths = [s for s in strings if not s.lstrip().startswith("Step 5")]  # skip the module docstring
    assert not any(marker in s for s in paths for marker in student_files)


def test_quotes_must_be_in_the_input():
    text = build_teacher_input(VENUE, SNAPSHOT)
    good = {"rooms": [{"room_name": "Garden Room", "quote": "The Garden Room seats 40 guests."}]}
    bad = {"rooms": [{"room_name": "Rooftop", "quote": "Our rooftop holds 200 guests."}]}
    assert unsupported_quotes(good, text) == []
    assert unsupported_quotes(bad, text) == ["Rooftop"]


def test_clean_label_drops_impossible_figures():
    label = clean_label({"rooms": [{"room_name": "A", "seated_max": 0, "standing_max": 50, "min": 80, "quote": "q"}],
                         "min_spend_usd": -1, "total_seats": 120})
    assert label["rooms"][0] == {"room_name": "A", "seated_max": None, "standing_max": 50, "min": None, "quote": "q"}
    assert label["min_spend_usd"] is None and label["total_seats"] == 120


def test_schema_is_strict():
    def check(node):
        if node.get("type") == "object":
            assert node.get("additionalProperties") is False
            assert set(node["required"]) == set(node["properties"])
            for child in node["properties"].values():
                check(child)
        if node.get("type") == "array":
            check(node["items"])
    check(TEACHER_SCHEMA)


def test_request_uses_structured_output_and_no_sampling_parameters():
    params = request_params("claude-sonnet-5-5", "teacher_v1", "text", "medium")
    assert params["output_config"]["format"]["type"] == "json_schema"
    assert "temperature" not in params and "tool_choice" not in params


def test_batch_is_half_price():
    usage = {"input_tokens": 1_000_000, "output_tokens": 100_000}
    assert token_cost("claude-sonnet-5-5", usage, batch=False) == 3.0
    assert token_cost("claude-sonnet-5-5", usage, batch=True) == 1.5
