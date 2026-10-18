import { describe, expect, it } from "vitest";
import {
  aggregateReads,
  competingNumbers,
  discoveryFeatures,
  DISCOVERY_POST_FETCH_ORDER,
  DISCOVERY_PRE_FETCH_ORDER,
  encodeConfidenceFeatures,
  modalValue,
  regexStatus,
  roomConfidenceFeatures,
  type ReadRoom,
} from "@/lib/discovery/features";

const room = (name: string, cap: number, extra: Partial<ReadRoom> = {}): ReadRoom => ({
  roomName: name,
  style: "unspecified",
  maxCapacity: cap,
  minCapacity: null,
  evidenceQuote: `The ${name} holds ${cap} guests.`,
  grounded: true,
  ...extra,
});

describe("modalValue", () => {
  it("counts reads within ±10% as the same value", () => {
    expect(modalValue([40, 40, 42])).toEqual({ value: 40, agreeing: 3, index: 0 });
  });

  it("does not merge values more than 10% apart", () => {
    expect(modalValue([40, 60, 40])?.agreeing).toBe(2);
  });

  it("breaks ties by the earliest read", () => {
    expect(modalValue([40, 80])).toEqual({ value: 40, agreeing: 1, index: 0 });
  });

  it("is null when no read produced a value", () => {
    expect(modalValue([null, null])).toBeNull();
  });
});

describe("aggregateReads", () => {
  it("merges the same room across reads and scores agreement", () => {
    const [garden] = aggregateReads([[room("Garden Room", 40)], [room("The Garden Room", 40)], [room("Garden", 42)]]);
    expect(garden.capacity).toBe(40);
    expect(garden.reads).toEqual([40, 40, 42]);
    expect(garden.selfConsistency).toBe(1);
  });

  it("counts a room missing from a successful read as disagreement", () => {
    const rooms = aggregateReads([
      [room("Garden Room", 40), room("Library", 20)],
      [room("Garden Room", 40)],
      [room("Garden Room", 40)],
    ]);
    const library = rooms.find((r) => r.roomName === "Library")!;
    expect(library.reads).toEqual([20, null, null]);
    expect(library.selfConsistency).toBeCloseTo(1 / 3);
  });

  it("ignores failed reads in the denominator", () => {
    const [garden] = aggregateReads([[room("Garden Room", 40)], null, [room("Garden Room", 40)]]);
    expect(garden.reads).toEqual([40, 40]);
    expect(garden.selfConsistency).toBe(1);
  });

  it("leaves self-consistency undefined below two successful reads", () => {
    const [garden] = aggregateReads([[room("Garden Room", 40)], null, null]);
    expect(garden.selfConsistency).toBeNull();
  });

  it("keeps seated and standing figures for one room as separate rows", () => {
    const rows = aggregateReads([
      [room("Loft", 50, { style: "seated" }), room("Loft", 80, { style: "standing" })],
      [room("Loft", 50, { style: "seated" }), room("Loft", 80, { style: "standing" })],
    ]);
    expect(rows.map((r) => [r.style, r.capacity])).toEqual([
      ["seated", 50],
      ["standing", 80],
    ]);
  });

  it("takes quote and grounding from the read that supplied the mode", () => {
    const [r] = aggregateReads([
      [room("Garden Room", 90, { grounded: false })],
      [room("Garden Room", 40)],
      [room("Garden Room", 40)],
    ]);
    expect(r.capacity).toBe(40);
    expect(r.grounded).toBe(true);
  });
});

describe("regexStatus / competingNumbers", () => {
  it("agrees within ±20%", () => {
    expect(regexStatus(40, [48])).toBe("agree");
    expect(regexStatus(40, [32])).toBe("agree");
    expect(regexStatus(40, [49])).toBe("disagree");
    expect(regexStatus(40, [31])).toBe("disagree");
    expect(regexStatus(40, [])).toBe("absent");
  });

  it("counts distinct capacity figures and caps at 10", () => {
    expect(competingNumbers("Seats 40 guests. Up to 40 guests. Holds 120 people.")).toBe(2);
    const many = Array.from({ length: 15 }, (_, i) => `Seats ${10 + i} guests.`).join(" ");
    expect(competingNumbers(many)).toBe(10);
  });
});

describe("roomConfidenceFeatures / encodeConfidenceFeatures", () => {
  const text = "The Garden Room seats 40 guests for private dinners.";

  it("builds the six model columns", () => {
    const f = roomConfidenceFeatures({ capacity: 40, grounded: true, selfConsistency: 2 / 3 }, text, true)!;
    expect(encodeConfidenceFeatures(f)).toEqual({
      self_consistency: 2 / 3,
      regex_agree: 1,
      regex_absent: 0,
      grounded: 1,
      competing_numbers: 1,
      private_page_found: 1,
    });
  });

  it("is null when self-consistency is undefined", () => {
    expect(roomConfidenceFeatures({ capacity: 40, grounded: true, selfConsistency: null }, text, true)).toBeNull();
  });
});

describe("discoveryFeatures", () => {
  it("one-hots the bucket against casual_restaurant and flags missing Google fields", () => {
    const row = discoveryFeatures({
      bucket: "steakhouse_grill",
      name: "Ruth's Steakhouse",
      priceLevel: null,
      rating: 4.5,
      userRatingCount: null,
    });
    expect(row.bucket_steakhouse_grill).toBe(1);
    expect(row.bucket_hotel).toBe(0);
    expect(row).not.toHaveProperty("bucket_casual_restaurant");
    expect(row.price_level).toBeNull();
    expect(row.price_missing).toBe(1);
    expect(row.rating).toBe(4.5);
    expect(row.log_reviews).toBeNull();
    expect(row.reviews_missing).toBe(1);
    expect(row.name_steakhouse).toBe(1);
    expect(row).not.toHaveProperty("has_external_event_link");
  });

  it("produces exactly the declared column order for each variant", () => {
    const base = { bucket: "hotel" as const, name: "Café Grand", priceLevel: 3, rating: 4, userRatingCount: 99 };
    expect(Object.keys(discoveryFeatures(base)).sort()).toEqual([...DISCOVERY_PRE_FETCH_ORDER].sort());
    const post = discoveryFeatures({ ...base, hasExternalEventLink: true });
    expect(Object.keys(post).sort()).toEqual([...DISCOVERY_POST_FETCH_ORDER].sort());
    expect(post.name_cafe).toBe(1);
    expect(post.log_reviews).toBeCloseTo(Math.log1p(99));
  });
});
