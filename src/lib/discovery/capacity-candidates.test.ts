import { describe, expect, it } from "vitest";
import { extractCapacityCandidates, extractPageNumberCandidates, clusterNumberHits } from "@/lib/discovery/scraper";

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

describe("extractPageNumberCandidates", () => {
  const page = (text: string, privateDining = false) => [{ text, privateDining }];

  it("keeps a regex capacity and a nearby bare number, and drops an isolated year-like number", () => {
    const hits = extractPageNumberCandidates(
      page(
        "The Garden Room holds 40 guests. Call 212-555-0100. A patio for 12. " +
          "x".repeat(80) +
          " Opened 1998."
      )
    );
    const values = hits.map((h) => h.value).sort((a, b) => a - b);
    expect(values).toContain(40);
    expect(values).toContain(12);
    expect(values).not.toContain(1998);
    expect(hits.find((h) => h.value === 40)?.regexHit).toBe(true);
  });

  it("marks a price and a reservation phrase", () => {
    const hits = extractPageNumberCandidates(page("Book a table for 2 guests. Minimum spend $500 for the room."));
    const price = hits.find((h) => h.value === 500);
    expect(price?.looksLikeJunk).toBe(true);
    const two = hits.find((h) => h.value === 2);
    expect(two?.reservationPhraseNear).toBe(true);
  });

  it("clusters values within 3 percent", () => {
    const hits = extractPageNumberCandidates(page("The hall holds 100 guests, or 103 people."));
    const clusters = clusterNumberHits(hits);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].length).toBeGreaterThan(1);
  });
});
