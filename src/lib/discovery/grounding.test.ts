import { describe, expect, it } from "vitest";
import { containsNumber, isGrounded, normalizeForGrounding, numberWords } from "@/lib/discovery/grounding";

const PAGE = `## Private Events
The **Garden Room** holds 40 guests for seated dinners.
Our [Library](https://example.com/library) welcomes up to “sixty” guests.
The ballroom seats one hundred and twenty people.
Food & beverage minimum: $2,500 on weekends.`;

describe("isGrounded", () => {
  it("accepts a verbatim quote across markdown emphasis", () => {
    expect(isGrounded("The Garden Room holds 40 guests for seated dinners.", PAGE, 40)).toBe(true);
  });

  it("accepts a quote whose link markup was dropped", () => {
    expect(isGrounded('Our Library welcomes up to "sixty" guests', PAGE, 60)).toBe(true);
  });

  it("matches curly quotes against straight ones", () => {
    expect(isGrounded("Our Library welcomes up to “sixty” guests", PAGE, 60)).toBe(true);
  });

  it("recognises a capacity written in words", () => {
    expect(isGrounded("The ballroom seats one hundred and twenty people.", PAGE, 120)).toBe(true);
  });

  it("accepts thousands separators", () => {
    expect(isGrounded("Food & beverage minimum: $2,500 on weekends.", PAGE, 2500)).toBe(true);
  });

  it("rejects a fabricated quote even when it is plausible", () => {
    expect(isGrounded("The Garden Room holds 120 guests for receptions.", PAGE, 120)).toBe(false);
  });

  it("rejects a real quote that does not state the claimed number", () => {
    expect(isGrounded("The Garden Room holds 40 guests for seated dinners.", PAGE, 400)).toBe(false);
    expect(isGrounded("The Garden Room holds 40 guests for seated dinners.", PAGE, 4)).toBe(false);
  });

  it("rejects empty or trivially short quotes", () => {
    expect(isGrounded("", PAGE, 40)).toBe(false);
    expect(isGrounded("40", PAGE, 40)).toBe(false);
    expect(isGrounded(undefined, PAGE, 40)).toBe(false);
  });
});

describe("number words", () => {
  it("spells hyphenated and hundreds forms", () => {
    expect(numberWords(45)).toEqual(["forty five"]);
    expect(numberWords(120)).toContain("one hundred and twenty");
    expect(numberWords(120)).toContain("a hundred twenty");
    expect(numberWords(201)).toEqual([]);
  });

  it("does not read 20 out of 'one hundred twenty'", () => {
    expect(containsNumber(normalizeForGrounding("seats one hundred twenty"), 20)).toBe(false);
    expect(containsNumber(normalizeForGrounding("seats forty-five"), 45)).toBe(true);
  });
});
