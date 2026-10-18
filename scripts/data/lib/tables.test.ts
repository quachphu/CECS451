import { describe, expect, it } from "vitest";
import {
  assertNoLeakage,
  assignSplits,
  confidenceRow,
  discoveryRow,
  LeakageError,
  type VenueLabel,
} from "./tables";

describe("assignSplits", () => {
  const venues = [
    { venueId: "nyc-1", domain: "a.com", city: "NYC" },
    { venueId: "nyc-2", domain: "b.com", city: "NYC" },
    { venueId: "la-1", domain: "c.com", city: "LA" },
    { venueId: "sf-1", domain: "c.com", city: "SF" }, // shares a domain with an LA venue
  ];

  it("puts gold and LA venues in test, and keeps a test domain out of train", () => {
    const s = assignSplits(venues, new Set(["nyc-2"]));
    expect(Object.fromEntries(s)).toEqual({
      "nyc-1": "train",
      "nyc-2": "test_gold",
      "la-1": "test_la_teacher",
      "sf-1": "test_la_teacher",
    });
  });
});

describe("assertNoLeakage", () => {
  it("throws for a gold venue, an LA venue or a shared domain in train", () => {
    const test = [{ domain: "t.com" }];
    expect(() =>
      assertNoLeakage(
        [{ venue_id: "x", domain: "a.com", city: "NYC" }],
        test,
        new Set(["x"]),
      ),
    ).toThrow(LeakageError);
    expect(() =>
      assertNoLeakage(
        [{ venue_id: "y", domain: "a.com", city: "LA" }],
        test,
        new Set(),
      ),
    ).toThrow(LeakageError);
    expect(() =>
      assertNoLeakage(
        [{ venue_id: "z", domain: "t.com", city: "SF" }],
        test,
        new Set(),
      ),
    ).toThrow(LeakageError);
    expect(() =>
      assertNoLeakage(
        [{ venue_id: "ok", domain: "a.com", city: "SF" }],
        test,
        new Set(),
      ),
    ).not.toThrow();
  });
});

const features = {
  self_consistency: 1,
  regex_status: "agree" as const,
  grounded: true,
  competing_numbers: 2,
  private_page_found: true,
};
const label: VenueLabel = {
  venueId: "sf-1",
  source: "teacher",
  status: "labeled",
  hosts: "yes",
  rooms: [
    { roomName: "Garden Room", seatedMax: 40, standingMax: null, min: null },
  ],
  totalSeats: null,
};
const ex = (over: Partial<Parameters<typeof confidenceRow>[0]> = {}) => ({
  venue_id: "sf-1",
  room_key: "sf-1#garden-room",
  room_name: "Garden Room",
  capacity: 44,
  style: "unspecified" as const,
  features,
  extraction_failed: false,
  ...over,
});

describe("confidenceRow", () => {
  it("labels a room within 10% as correct and encodes the features", () => {
    const r = confidenceRow(ex(), label);
    expect(r).toEqual({
      row: expect.objectContaining({
        y: 1,
        abs_rel_error: 0.1,
        regex_agree: 1,
        regex_absent: 0,
        grounded: 1,
        label_source: "teacher",
      }),
    });
  });

  it("labels an invented room 0", () => {
    const r = confidenceRow(ex({ room_name: "Rooftop", capacity: 200 }), label);
    expect(r).toEqual({
      row: expect.objectContaining({ y: 0, abs_rel_error: "" }),
    });
  });

  it("excludes failed extractions and unclear venues", () => {
    expect(
      confidenceRow(ex({ extraction_failed: true, features: null }), label),
    ).toEqual({ excluded: "extraction_failed" });
    expect(confidenceRow(ex(), { ...label, status: "unclear" })).toEqual({
      excluded: "label_unclear",
    });
    expect(confidenceRow(ex(), undefined)).toEqual({ excluded: "no_label" });
  });
});

describe("discoveryRow", () => {
  it("uses Google fields when matched and leaves missing values empty (no imputation)", () => {
    const row = discoveryRow(
      { name: "Ruth's Chris", bucket: "casual_restaurant" },
      {
        google_match: "matched",
        primary_type: "steak_house",
        types: "steak_house|restaurant",
        display_name: "Ruth's Chris Steak House",
        price_level: "",
        rating: "4.6",
        user_rating_count: "812",
      },
      true,
    );
    expect(row.bucket_steakhouse_grill).toBe(1);
    expect(row.price_level).toBeNull();
    expect(row.price_missing).toBe(1);
    expect(row.rating).toBe(4.6);
    expect(row.has_external_event_link).toBe(1);
    expect(row.name_steakhouse).toBe(0);
  });

  it("falls back to the sampling bucket and flags everything missing without a match", () => {
    const row = discoveryRow(
      { name: "Hotel Zed", bucket: "hotel" },
      { google_match: "none" },
      false,
    );
    expect(row.bucket_hotel).toBe(1);
    expect([
      row.rating_missing,
      row.reviews_missing,
      row.price_missing,
    ]).toEqual([1, 1, 1]);
    expect(row.name_hotel).toBe(1);
  });
});
