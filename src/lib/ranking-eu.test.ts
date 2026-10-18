import { describe, expect, it } from "vitest";
import { MIN_PFIT, priorFit, rankVenues, type SearchCriteria, type VenueWithRelations } from "@/lib/ranking";
import type { CommuteResult } from "@/lib/geo/commute";
import type { TrustLevel, VenueRoomRow } from "@/lib/supabase/types";
import { loadModel } from "@/lib/discovery/model-scoring";

// A trained model is needed for stored scores to count (otherwise: v0 tier weights).
const trained = loadModel(
  { feature_order: ["x"], impute_median: { x: 0 }, scaler: {}, coef: [0], intercept: 0, calibration: null },
  "test",
  "trained-test"
);
const scoredBy = { confidence_features: { modelVersion: "trained-test" } };

type RoomSpec = Partial<VenueRoomRow> & { max: number; trust?: TrustLevel };

function venue(id: string, rooms: RoomSpec[], overrides: Partial<VenueWithRelations> = {}): VenueWithRelations {
  return {
    id,
    source: "auto_discovered",
    place_source_id: id,
    name: `Venue ${id}`,
    formatted_address: `${id} Test St`,
    lat: 0,
    lng: 0,
    city_slug: "auto",
    category: "restaurant",
    neighborhood: null,
    price_tier: null,
    price_tier_trust: "unverified",
    min_spend_usd: null,
    min_spend_trust: "unverified",
    phone: null,
    email: null,
    website: null,
    description: null,
    dietary_notes: null,
    dietary_trust: "unverified",
    menu_url: null,
    menu_trust: "unverified",
    source_note: null,
    last_checked_at: "2026-10-01T00:00:00Z",
    created_at: "2026-10-01T00:00:00Z",
    photos: [],
    rooms: rooms.map(({ max, trust, ...rest }, i) => ({
      id: `${id}-r${i}`,
      venue_id: id,
      room_name: `Room ${i}`,
      min_capacity: null,
      max_capacity: max,
      style: "either",
      capacity_trust: trust ?? "verified",
      notes: null,
      ...rest,
    })),
    ...overrides,
  };
}

const commute = (minutes: number): CommuteResult => ({
  distanceMeters: minutes * 80,
  durationSeconds: minutes * 60,
  estimated: false,
});
const criteria = (headcount: number): SearchCriteria => ({ headcount, maxCommuteMinutes: 20, commuteMode: "walk" });

describe("expected-utility ranking", () => {
  it("includes an estimate venue for 200 guests at low pFit instead of excluding it on a fake number", () => {
    const estimate = venue(
      "hotel-estimate",
      [{ max: 60, trust: "unverified", is_estimate: true, room_name: "Capacity unconfirmed" }],
      { category: "hotel" }
    );
    const verified = venue("ballroom", [{ max: 250, trust: "verified", capacity_confidence: 0.9 }], {
      category: "hotel",
    });

    const results = rankVenues(
      criteria(200),
      [estimate, verified],
      new Map([
        ["hotel-estimate", commute(5)],
        ["ballroom", commute(5)],
      ])
    );

    expect(results.map((r) => r.venue.id)).toEqual(["ballroom", "hotel-estimate"]);
    const est = results[1];
    expect(est.pFit).toBeCloseTo(priorFit("hotel", 200), 5);
    expect(est.pFit!).toBeLessThan(0.5);
    // The guessed 60 is never presented as a capacity.
    expect(est.reasons.join(" ")).not.toMatch(/up to 60/);
    expect(est.reasons.join(" ")).toMatch(/no published capacity/i);
  });

  it(`drops venues below the MIN_PFIT floor (${MIN_PFIT})`, () => {
    // A restaurant's base rate for 200 guests is tiny, so an estimate room can't carry it.
    const results = rankVenues(
      criteria(200),
      [venue("bistro", [{ max: 60, trust: "unverified", is_estimate: true }])],
      new Map([["bistro", commute(5)]])
    );

    expect(priorFit("restaurant", 200)).toBeLessThan(MIN_PFIT);
    expect(results).toEqual([]);
  });

  it("keeps an undersized but weakly believed room, flagged as maybe too small", () => {
    const results = rankVenues(
      criteria(50),
      [
        venue("bar", [{ max: 40, trust: "likely", capacity_confidence: 0.4, room_name: "Back Bar" }], {
          category: "bar",
        }),
      ],
      new Map([["bar", commute(5)]])
    );

    expect(results).toHaveLength(1);
    expect(results[0].reasons[1]).toMatch(/may be too small for 50/);
  });

  it("excludes an undersized room when its figure is strongly believed", () => {
    const results = rankVenues(
      criteria(50),
      [venue("bar", [{ max: 40, trust: "likely", capacity_confidence: 0.9, ...scoredBy }], { category: "bar" })],
      new Map([["bar", commute(5)]]),
      { confidenceModel: trained }
    );

    expect(results).toEqual([]);
  });

  it("ignores a stored score from a placeholder or older model and uses the tier weight", () => {
    const doubted = venue("doubted", [{ max: 60, trust: "verified", capacity_confidence: 0.5 }]);
    const believed = venue("believed", [{ max: 60, trust: "likely", capacity_confidence: 0.95 }]);
    const results = rankVenues(
      criteria(50),
      [doubted, believed],
      new Map([
        ["doubted", commute(5)],
        ["believed", commute(5)],
      ]),
      { confidenceModel: trained }
    );
    expect(results.map((r) => r.venue.id)).toEqual(["doubted", "believed"]);
  });

  it("prefers stored capacity_confidence over the tier weight", () => {
    const doubted = venue("doubted", [{ max: 60, trust: "verified", capacity_confidence: 0.5, ...scoredBy }]);
    const believed = venue("believed", [{ max: 60, trust: "likely", capacity_confidence: 0.95, ...scoredBy }]);

    const results = rankVenues(
      criteria(50),
      [doubted, believed],
      new Map([
        ["doubted", commute(5)],
        ["believed", commute(5)],
      ]),
      { confidenceModel: trained }
    );

    expect(results.map((r) => r.venue.id)).toEqual(["believed", "doubted"]);
  });

  it("breaks exact ties deterministically, whatever order the rows arrive in", () => {
    const make = () => ["zeta", "alpha", "mid"].map((id) => venue(id, [{ max: 60 }], { name: id }));
    const commutes = new Map(["zeta", "alpha", "mid"].map((id) => [id, commute(5)]));

    const forward = rankVenues(criteria(50), make(), commutes).map((r) => r.venue.id);
    const reversed = rankVenues(criteria(50), make().reverse(), commutes).map((r) => r.venue.id);

    expect(forward).toEqual(["alpha", "mid", "zeta"]);
    expect(reversed).toEqual(forward);
  });

  it("hides '% likely to fit' while the confidence model is a placeholder", () => {
    const [result] = rankVenues(criteria(50), [venue("a", [{ max: 60, trust: "verified" }])], new Map([["a", commute(10)]]));
    expect(result.reasons.some((r) => /likely to fit/.test(r))).toBe(false);
    expect(result.reasons[2]).toBe("Capacity verified directly from the venue's own private-dining page");
  });

  it("with a trained model, puts the '% likely to fit' line third and leaves the other reasons as they were", () => {
    const [result] = rankVenues(
      criteria(50),
      [venue("a", [{ max: 60, trust: "verified" }])],
      new Map([["a", commute(10)]]),
      { showFitProbability: true }
    );

    expect(result.reasons[0]).toMatch(/^10 min walk/);
    expect(result.reasons[1]).toBe("Fits 50 in Room 0 (up to 60)");
    expect(result.reasons[2]).toMatch(/^About \d+% likely to fit your group$/);
    expect(result.reasons[3]).toBe("Capacity verified directly from the venue's own private-dining page");
    expect(result.pFit).toBeGreaterThan(0.9);
  });
});
