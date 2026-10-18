import json
from pathlib import Path

import pytest

from ml.grounding import contains_number, is_grounded, normalize_for_grounding

VECTORS = json.loads(
    (Path(__file__).resolve().parents[2] / "src/lib/discovery/__fixtures__/grounding-vectors.json").read_text()
)


@pytest.mark.parametrize("text,expected", VECTORS["normalize"])
def test_normalize_matches_typescript(text, expected):
    assert normalize_for_grounding(text) == expected


@pytest.mark.parametrize("text,value,expected", VECTORS["contains_number"])
def test_contains_number_matches_typescript(text, value, expected):
    assert contains_number(text, value) is expected


@pytest.mark.parametrize("quote,page,value,expected", VECTORS["grounded"])
def test_is_grounded_matches_typescript(quote, page, value, expected):
    assert is_grounded(quote, page, value) is expected
