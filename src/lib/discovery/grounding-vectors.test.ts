import { describe, expect, it } from "vitest";
import vectors from "@/lib/discovery/__fixtures__/grounding-vectors.json";
import { containsNumber, isGrounded, normalizeForGrounding } from "@/lib/discovery/grounding";

// The same vectors run in ml/tests/test_grounding.py, so the teacher-label
// validation (Python) and the app's grounding check (TypeScript) agree.
describe("grounding vectors shared with Python", () => {
  it.each(vectors.normalize as Array<[string, string]>)("normalizes %j", (input, expected) => {
    expect(normalizeForGrounding(input)).toBe(expected);
  });

  it.each(vectors.contains_number as Array<[string, number, boolean]>)(
    "containsNumber(%j, %d)",
    (text, n, expected) => {
      expect(containsNumber(text, n)).toBe(expected);
    }
  );

  it.each(vectors.grounded as Array<[string, string, number, boolean]>)(
    "isGrounded(%j)",
    (quote, page, n, expected) => {
      expect(isGrounded(quote, page, n)).toBe(expected);
    }
  );
});
