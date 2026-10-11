/**
 * Grounding check for LLM-extracted facts.
 *
 * A strict JSON schema guarantees the *shape* of the model's answer, not that
 * it is true: a correctly-shaped "Garden Room, 120 guests" can still be
 * invented (Ji et al. 2023 [P2] call this an intrinsic/extrinsic
 * hallucination). Following the evidence-citation design of ALCE (Gao et al.
 * 2023 [P3]), the extraction tier must quote the sentence that states each
 * figure, and a figure is only kept when that quote actually appears on the
 * page and actually contains the number.
 *
 * ALCE scores citation support with an NLI model; here support is checked by
 * exact (normalised) substring match instead. That is stricter — paraphrased
 * quotes are rejected — but deterministic, free, and needs no model, which is
 * the right trade for a figure a planner may book against.
 */

const ONES = [
  "",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
  "sixteen",
  "seventeen",
  "eighteen",
  "nineteen",
];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

function underHundredWords(n: number): string[] {
  if (n < 20) return [ONES[n]];
  const tens = TENS[Math.floor(n / 10)];
  const ones = n % 10;
  return ones === 0 ? [tens] : [`${tens} ${ONES[ones]}`];
}

/**
 * Spelled-out forms of 1–200 as they appear after normalisation (hyphens
 * become spaces, so "forty-five" is matched as "forty five"). Covers "one
 * hundred and twenty", "a hundred twenty", etc. Returns [] outside 1–200.
 */
export function numberWords(n: number): string[] {
  if (!Number.isInteger(n) || n < 1 || n > 200) return [];
  if (n < 100) return underHundredWords(n);
  if (n === 200) return ["two hundred"];
  const hundreds = ["one hundred", "a hundred"];
  if (n === 100) return hundreds;
  const rest = underHundredWords(n - 100);
  return hundreds.flatMap((h) => rest.flatMap((r) => [`${h} ${r}`, `${h} and ${r}`]));
}

/**
 * Normalises text so a faithfully copied quote matches the page it came from:
 * lowercase, curly quotes/apostrophes to straight, en/em dashes to "-",
 * markdown emphasis (`**`, `__`) removed, `[text](url)` links reduced to their
 * text, whitespace collapsed. Applied identically to quote and page.
 */
export function normalizeForGrounding(text: string): string {
  return text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\*\*|__/g, "")
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[–—]/g, "-")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** True when normalised text states `value`, as digits ("1,500" or "1500") or words. */
export function containsNumber(normalizedText: string, value: number): boolean {
  const digitForms = Array.from(new Set([String(value), value.toLocaleString("en-US")]));
  for (const form of digitForms) {
    if (new RegExp(`(?<![\\d,.])${escapeRegex(form)}(?![\\d]|[,.]\\d)`).test(normalizedText)) return true;
  }

  const spaced = normalizedText.replace(/-/g, " ");
  return numberWords(value).some((words) => {
    // "twenty" must not match inside "one hundred twenty" when the value is 20.
    const notAfterHundred = value < 100 ? "(?<!hundred )(?<!hundred and )" : "";
    return new RegExp(`${notAfterHundred}\\b${escapeRegex(words)}\\b(?! hundred)`).test(spaced);
  });
}

/** Quotes shorter than this can't meaningfully cite anything ("40 guests"). */
const MIN_QUOTE_CHARS = 8;

/**
 * True only when `quote` (normalised, with surrounding quote marks and trailing
 * punctuation removed) is a substring of the normalised page text AND the
 * quote itself states `value`.
 */
export function isGrounded(quote: string | null | undefined, pageText: string, value: number): boolean {
  if (!quote) return false;
  const q = normalizeForGrounding(quote)
    .replace(/^["']+|["']+$/g, "")
    .replace(/[.!?;:,]+$/, "")
    .trim();
  if (q.length < MIN_QUOTE_CHARS) return false;
  if (!normalizeForGrounding(pageText).includes(q)) return false;
  return containsNumber(q, value);
}

/** The first page whose text contains the quote — where a planner can go check it. */
export function findEvidenceUrl(
  quote: string | null | undefined,
  pages: Array<{ url: string; text: string }>
): string | null {
  if (!quote) return null;
  const q = normalizeForGrounding(quote).replace(/[.!?;:,]+$/, "");
  return pages.find((p) => normalizeForGrounding(p.text).includes(q))?.url ?? null;
}
