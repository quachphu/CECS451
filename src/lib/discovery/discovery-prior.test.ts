import { describe, expect, it } from "vitest";
import {
  discoveryPriorScore,
  encodePriorFeatures,
  orderByPrior,
  PRIOR_KINDS,
  PRIOR_NAME_KEYWORDS,
  scorePrivateEventPrior,
  TRAINED_DISCOVERY_PRIOR,
  V0_PRIOR_MODEL,
} from "@/lib/discovery/discovery-prior";
import { DISCOVERY_PRE_FETCH_ORDER } from "@/lib/discovery/features";
import { loadModel } from "@/lib/discovery/model-scoring";
import type { CandidateVenue } from "@/lib/discovery/places";

const c = (name: string, overrides: Partial<CandidateVenue> = {}): CandidateVenue => ({
  placeSourceId: name,
  name,
  formattedAddress: "",
  lat: 0,
  lng: 0,
  category: "restaurant",
  website: "https://example.com",
  ...overrides,
});

describe("discovery prior", () => {
  it("rates a banquet hall above a steakhouse above a pizza counter", () => {
    const banquet = scorePrivateEventPrior(c("Grand Hall", { category: "banquet hall", types: ["banquet_hall"] }));
    const steak = scorePrivateEventPrior(
      c("Smith's Steakhouse", { types: ["steak_house", "restaurant"], priceLevelGoogle: 3 })
    );
    const pizza = scorePrivateEventPrior(
      c("Joe's Pizza Express", { types: ["pizza_restaurant", "meal_takeaway"], priceLevelGoogle: 1 })
    );

    expect(banquet).toBeGreaterThan(steak);
    expect(steak).toBeGreaterThan(pizza);
  });

  it("uses OSM cuisine tags when Google types are absent", () => {
    expect(encodePriorFeatures(c("Bob's", { category: "restaurant", cuisine: "steak_house" }))).toMatchObject({
      "kind=steakhouse": 1,
      "kind=restaurant": 1,
    });
  });

  it("favours venues with a website, which the scraper can actually read", () => {
    expect(scorePrivateEventPrior(c("A"))).toBeGreaterThan(scorePrivateEventPrior(c("A", { website: undefined })));
  });

  it("orders highest prior first and keeps discovery order among equals", () => {
    const list = [
      c("Pizza Express", { types: ["fast_food"] }),
      c("First"),
      c("Second"),
      c("Banquet Hall", { types: ["banquet_hall"] }),
    ];
    expect(orderByPrior(list).map((v) => v.name)).toEqual(["Banquet Hall", "First", "Second", "Pizza Express"]);
  });

  it("has a weight for every v0 feature and nothing else", () => {
    const expected = [
      "priceLevel",
      "priceLevelMissing",
      "hasWebsite",
      ...PRIOR_KINDS.map((k) => `kind=${k}`),
      ...PRIOR_NAME_KEYWORDS.map((w) => `name=${w}`),
    ];
    expect(new Set(Object.keys(V0_PRIOR_MODEL.weights))).toEqual(new Set(expected));
  });
});

describe("trained discovery prior", () => {
  const order = [...DISCOVERY_PRE_FETCH_ORDER];
  const coef = order.map((f) => (f === "bucket_event_space" ? 3 : f === "name_pizza" ? -2 : 0));
  const pre = loadModel(
    {
      feature_order: order,
      impute_median: Object.fromEntries(order.map((f) => [f, f === "rating" ? 4.2 : 0])),
      scaler: { rating: { mean: 4.2, std: 0.4 } },
      coef,
      intercept: -0.5,
      calibration: null,
    },
    "test",
    "trained-test"
  );
  const trained = { version: "trained-test", pre_fetch: pre, post_fetch: null };

  it("ships as a placeholder until trained, so the v0 prior orders candidates", () => {
    expect(TRAINED_DISCOVERY_PRIOR).toBeNull();
    expect(discoveryPriorScore(c("Grand Hall", { types: ["banquet_hall"] }))).toBe(
      scorePrivateEventPrior(c("Grand Hall", { types: ["banquet_hall"] }))
    );
  });

  it("scores Google types, rating and name keywords through features.ts when loaded", () => {
    const hall = discoveryPriorScore(c("Grand Hall", { primaryType: "event_venue", types: ["event_venue"], rating: 4.6 }), trained);
    const pizza = discoveryPriorScore(c("Joe's Pizza", { types: ["pizza_restaurant"] }), trained);
    expect(hall).toBeCloseTo(1 / (1 + Math.exp(-(3 - 0.5))), 6);
    expect(pizza).toBeCloseTo(1 / (1 + Math.exp(-(-2 - 0.5))), 6);
    expect(orderByPrior([c("Joe's Pizza"), c("Grand Hall", { types: ["event_venue"] })], trained).map((v) => v.name)).toEqual([
      "Grand Hall",
      "Joe's Pizza",
    ]);
  });
});
