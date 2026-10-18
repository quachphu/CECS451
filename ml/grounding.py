"""Python port of src/lib/discovery/grounding.ts.

Teacher quotes are validated with exactly the normalisation the app uses for
the student's evidence quotes. ml/tests/test_grounding.py runs the shared
vectors in src/lib/discovery/__fixtures__/grounding-vectors.json, which the
TypeScript tests run too.
"""

from __future__ import annotations

import re

_ONES = [
    "", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
    "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen",
]
_TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"]
MIN_QUOTE_CHARS = 8


def _under_hundred(n: int) -> list[str]:
    if n < 20:
        return [_ONES[n]]
    tens, ones = _TENS[n // 10], n % 10
    return [tens] if ones == 0 else [f"{tens} {_ONES[ones]}"]


def number_words(n: int) -> list[str]:
    """Spelled-out forms of 1-200, as they appear after normalisation."""
    if not isinstance(n, int) or n < 1 or n > 200:
        return []
    if n < 100:
        return _under_hundred(n)
    if n == 200:
        return ["two hundred"]
    hundreds = ["one hundred", "a hundred"]
    if n == 100:
        return hundreds
    rest = _under_hundred(n - 100)
    return [form for h in hundreds for r in rest for form in (f"{h} {r}", f"{h} and {r}")]


def normalize_for_grounding(text: str) -> str:
    text = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", text)
    text = re.sub(r"\*\*|__", "", text)
    text = re.sub("[‘’‚‛′]", "'", text)
    text = re.sub("[“”„‟″]", '"', text)
    text = re.sub("[–—]", "-", text)
    # JavaScript's \s and toLowerCase(); Python's str.lower() matches for these inputs.
    return re.sub(r"\s+", " ", text.lower()).strip()


def contains_number(normalized_text: str, value: int) -> bool:
    forms = list(dict.fromkeys([str(value), f"{value:,}"]))
    for form in forms:
        if re.search(rf"(?<![\d,.]){re.escape(form)}(?![\d]|[,.]\d)", normalized_text):
            return True
    spaced = normalized_text.replace("-", " ")
    for words in number_words(value):
        not_after_hundred = "(?<!hundred )(?<!hundred and )" if value < 100 else ""
        if re.search(rf"{not_after_hundred}\b{re.escape(words)}\b(?! hundred)", spaced):
            return True
    return False


def clean_quote(quote: str) -> str:
    q = normalize_for_grounding(quote)
    q = re.sub(r"^[\"']+|[\"']+$", "", q)
    q = re.sub(r"[.!?;:,]+$", "", q)
    return q.strip()


def quote_found(quote: str | None, page_text: str) -> bool:
    """The quote, normalised, is a substring of the normalised text."""
    if not quote:
        return False
    q = clean_quote(quote)
    return len(q) >= MIN_QUOTE_CHARS and q in normalize_for_grounding(page_text)


def is_grounded(quote: str | None, page_text: str, value: int) -> bool:
    if not quote_found(quote, page_text):
        return False
    return contains_number(clean_quote(quote or ""), value)
