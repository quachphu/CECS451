import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DISCOVERY_PRIOR_MODEL,
  encodePriorFeatures,
  orderByPrior,
  PRIOR_KINDS,
  PRIOR_NAME_KEYWORDS,
  scorePrivateEventPrior,
} from "@/lib/discovery/discovery-prior";
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

  it("stays in step with the Python trainer and the model JSON", () => {
    const py = readFileSync(new URL("../../../scripts/train_confidence.py", import.meta.url), "utf8");
    const list = (name: string) =>
      Array.from(py.match(new RegExp(`^${name} = \\[(.*)\\]$`, "m"))![1].matchAll(/"([^"]+)"/g), (m) => m[1]);

    expect(list("PRIOR_KINDS")).toEqual([...PRIOR_KINDS]);
    expect(list("PRIOR_NAME_KEYWORDS")).toEqual([...PRIOR_NAME_KEYWORDS]);
    const expected = [
      "priceLevel",
      "priceLevelMissing",
      "hasWebsite",
      ...PRIOR_KINDS.map((k) => `kind=${k}`),
      ...PRIOR_NAME_KEYWORDS.map((w) => `name=${w}`),
    ];
    expect(new Set(Object.keys(DISCOVERY_PRIOR_MODEL.weights))).toEqual(new Set(expected));
  });
});
