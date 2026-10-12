import { describe, expect, it } from "vitest";
import { extractCapacityCandidates } from "@/lib/discovery/scraper";

describe("extractCapacityCandidates", () => {
  it("drops reservation phrasing like 'table for 2 people'", () => {
    const values = extractCapacityCandidates(
      "Book a table for 2 people tonight. Reservation for 8 guests available."
    ).map((c) => c.value);
    expect(values).toEqual([]);
  });

  it("keeps a real figure that merely sits near a reservation widget", () => {
    const values = extractCapacityCandidates(
      "Book a table for 2 people online. The Garden Room holds 40 guests for private dinners."
    ).map((c) => c.value);
    expect(values).toEqual([40]);
  });

  it("drops values below 6", () => {
    expect(extractCapacityCandidates("Our booth seats 4 guests.")).toEqual([]);
  });

  it("finds the nearest preceding room name", () => {
    const [c] = extractCapacityCandidates("Private Events. The Garden Room holds 40 guests for seated dinners.");
    expect(c.roomHint).toBe("Garden Room");
    expect(c.sentence).toBe("The Garden Room holds 40 guests for seated dinners.");
    expect(c.context).toContain("Private Events");
  });

  it("does not carry a room name across a sentence boundary", () => {
    const candidates = extractCapacityCandidates("The Garden Room holds 40 guests. Our patio seats 60 guests.");
    expect(candidates.map((c) => [c.value, c.roomHint])).toEqual([
      [40, "Garden Room"],
      [60, null],
    ]);
  });

  it("leaves a lowercase room description unhinted", () => {
    const [c] = extractCapacityCandidates("Our main dining room seats 180 guests across two levels.");
    expect(c.roomHint).toBeNull();
  });
});
