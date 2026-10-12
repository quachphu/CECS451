import { describe, expect, it } from "vitest";
import {
  CONFIDENCE_MODEL,
  encodeConfidenceFeatures,
  featureLog,
  scoreConfidence,
  type ConfidenceFeatures,
} from "@/lib/discovery/confidence";
import { buildVenueDraft } from "@/lib/discovery/trust";
import type { CandidateVenue } from "@/lib/discovery/places";
import type { ScrapedSignals } from "@/lib/discovery/scraper";

const base: ConfidenceFeatures = {
  source: "regex",
  agreementSpread: null,
  privateDiningPageFound: true,
  grounded: true,
  competingCandidates: 0,
  hasRoomHint: false,
  renderedWithJs: false,
  category: "restaurant",
};

describe("placeholder-0 confidence model", () => {
  it("is the placeholder version until refit", () => {
    expect(CONFIDENCE_MODEL.version).toBe("placeholder-0");
  });

  it.each([
    ["planner", { ...base, source: "planner" as const, privateDiningPageFound: false, grounded: false }, 0.98],
    ["regex + LLM agree", { ...base, source: "both" as const, agreementSpread: 0.05, hasRoomHint: true }, 0.9],
    ["grounded LLM", { ...base, source: "llm" as const, hasRoomHint: true }, 0.7],
    ["regex only", base, 0.6],
    [
      "category estimate",
      { ...base, source: "estimate" as const, privateDiningPageFound: false, grounded: false },
      0.2,
    ],
  ])("roughly reproduces the old tier weight for %s", (_label, features, target) => {
    expect(scoreConfidence(features)).toBeCloseTo(target, 1);
  });

  it("drops a disagreeing pair well below an agreeing one", () => {
    const agree = scoreConfidence({ ...base, source: "both", agreementSpread: 0.05, hasRoomHint: true });
    const disagree = scoreConfidence({ ...base, source: "both", agreementSpread: 0.55, hasRoomHint: true });
    expect(disagree).toBeLessThan(agree - 0.25);
  });

  it("stays a probability", () => {
    const extreme = scoreConfidence({ ...base, competingCandidates: 500 });
    expect(extreme).toBeGreaterThanOrEqual(0);
    expect(extreme).toBeLessThanOrEqual(1);
  });

  it("encodes one-hot source and category buckets", () => {
    expect(encodeConfidenceFeatures({ ...base, category: "banquet_hall" })).toMatchObject({
      "source=regex": 1,
      "category=banquet": 1,
      privateDiningPageFound: 1,
    });
  });

  it("logs the model version with the features", () => {
    expect(featureLog(base)).toMatchObject({ source: "regex", modelVersion: "placeholder-0" });
  });
});

describe("drafts carry write-time confidence", () => {
  const venue: CandidateVenue = {
    placeSourceId: "osm-1",
    name: "Test",
    formattedAddress: "1 Test St",
    lat: 0,
    lng: 0,
    category: "restaurant",
    website: "https://example.com",
  };
  const signals = (overrides: Partial<ScrapedSignals>): ScrapedSignals => ({
    privateDiningPageFound: true,
    scrapedUrls: ["https://example.com"],
    capacityNumbers: [],
    minSpendUsd: [],
    email: null,
    phone: null,
    descriptionExcerpt: null,
    menuUrl: null,
    dietaryNotes: null,
    renderedWithJs: false,
    combinedText: "",
    ...overrides,
  });

  it("orders agreement > regex-only > estimate", () => {
    const agree = buildVenueDraft(venue, signals({ capacityNumbers: [40] }), {
      rooms: [{ roomName: "Room", maxCapacity: 40, minCapacity: null, evidenceQuote: "holds 40 guests" }],
      minSpendUsd: null,
      dietaryNotes: null,
      hostsPrivateEvents: true,
    }).rooms[0];
    const regexOnly = buildVenueDraft(venue, signals({ capacityNumbers: [40] })).rooms[0];
    const estimate = buildVenueDraft({ ...venue, website: undefined }, null).rooms[0];

    expect(agree.confidenceFeatures.source).toBe("both");
    expect(agree.confidence).toBeGreaterThan(regexOnly.confidence);
    expect(regexOnly.confidence).toBeGreaterThan(estimate.confidence);
    expect(estimate.confidenceFeatures.source).toBe("estimate");
  });
});

describe("TypeScript/Python feature parity", () => {
  it("train_confidence.py encodes exactly the features the model and encoder use", async () => {
    const { readFileSync } = await import("node:fs");
    const py = readFileSync(new URL("../../../scripts/train_confidence.py", import.meta.url), "utf8");
    const list = (name: string) =>
      Array.from(py.match(new RegExp(`^${name} = \\[(.*)\\]$`, "m"))![1].matchAll(/"([^"]+)"/g), (m) => m[1]);
    const { CATEGORY_BUCKETS } = await import("@/lib/category-bucket");

    const pyNames = [
      ...list("SOURCES").map((s) => `source=${s}`),
      ...list("NUMERIC"),
      ...list("BUCKETS").map((b) => `category=${b}`),
    ];
    expect(new Set(pyNames)).toEqual(new Set(Object.keys(CONFIDENCE_MODEL.weights)));
    expect(list("BUCKETS")).toEqual([...CATEGORY_BUCKETS]);
    for (const key of Object.keys(encodeConfidenceFeatures(base))) expect(pyNames).toContain(key);
  });
});
