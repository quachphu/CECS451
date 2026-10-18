import { describe, expect, it } from "vitest";
import {
  featureLog,
  scoreRoomConfidence,
  TRAINED_CONFIDENCE_MODEL,
  type ConfidenceFeatures,
} from "@/lib/discovery/confidence";
import { CONFIDENCE_FEATURE_ORDER } from "@/lib/discovery/features";
import { loadModel } from "@/lib/discovery/model-scoring";
import { buildVenueDraft } from "@/lib/discovery/trust";
import type { CandidateVenue } from "@/lib/discovery/places";
import type { ScrapedSignals } from "@/lib/discovery/scraper";
import { capacityBelief } from "@/lib/ranking";

const features: ConfidenceFeatures = {
  self_consistency: 1,
  regex_status: "agree",
  grounded: true,
  competing_numbers: 2,
  private_page_found: true,
};

const order = [...CONFIDENCE_FEATURE_ORDER];
const toy = loadModel(
  {
    feature_order: order,
    impute_median: Object.fromEntries(order.map((f) => [f, 0])),
    scaler: { self_consistency: { mean: 0.8, std: 0.2 }, competing_numbers: { mean: 3, std: 2 } },
    coef: [1, 0.5, 0, 1, -0.2, 0.3],
    intercept: -0.4,
    calibration: null,
  },
  "toy",
  "trained-toy"
);

describe("confidence model guard", () => {
  it("ships as a placeholder, so no room is scored", () => {
    expect(TRAINED_CONFIDENCE_MODEL).toBeNull();
    expect(scoreRoomConfidence(features)).toBeNull();
    expect(featureLog("llm", features)).toMatchObject({ source: "llm", self_consistency: 1, regex_agree: 1, modelVersion: "none" });
  });

  it("scores with a trained model and logs its version", () => {
    // z = -0.4 + 1*(1-0.8)/0.2 + 0.5 + 1 + (-0.2)*(2-3)/2 + 0.3 = 2.5
    expect(scoreRoomConfidence(features, toy)).toBeCloseTo(1 / (1 + Math.exp(-2.5)), 3);
    expect(scoreRoomConfidence(null, toy)).toBeNull();
    expect(featureLog("regex", null, toy)).toEqual({ source: "regex", modelVersion: "trained-toy" });
  });
});

describe("capacityBelief", () => {
  const row = (version: string | null) => ({
    capacity_confidence: 0.42,
    capacity_trust: "verified" as const,
    confidence_features: version ? { modelVersion: version } : null,
  });

  it("uses a stored score only when the loaded trained model produced it", () => {
    expect(capacityBelief(row("trained-toy"), toy)).toBe(0.42);
    expect(capacityBelief(row("trained-older"), toy)).toBe(0.9);
    expect(capacityBelief(row("placeholder-0"), toy)).toBe(0.9);
    expect(capacityBelief(row("trained-toy"), null)).toBe(0.9);
  });
});

describe("drafts record how each figure was obtained", () => {
  const venue: CandidateVenue = {
    placeSourceId: "osm-1",
    name: "Test",
    formattedAddress: "1 Test St",
    lat: 0,
    lng: 0,
    category: "restaurant",
    website: "https://example.com",
  };
  const page = "Private dining. The Garden Room holds 40 guests. Tables for 2 to 6 people.";
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
    combinedText: page,
    ...overrides,
  });
  const llm = (maxCapacity: number) => ({
    rooms: [{ roomName: "Garden Room", maxCapacity, minCapacity: null, evidenceQuote: "holds 40 guests", selfConsistency: 2 / 3 }],
    minSpendUsd: null,
    dietaryNotes: null,
    hostsPrivateEvents: true,
    inputText: page,
  });

  it("gives an LLM room the features of its own read", () => {
    const [room] = buildVenueDraft(venue, signals({ capacityNumbers: [40] }), llm(40)).rooms;
    expect(room.confidenceSource).toBe("both");
    expect(room.confidenceFeatures).toEqual({
      self_consistency: 2 / 3,
      regex_status: "agree",
      grounded: true,
      competing_numbers: 1,
      private_page_found: true,
    });
    expect(room.confidence).toBeNull(); // placeholder model
  });

  it("leaves a room showing another figure, regex-only rooms and estimates unscored", () => {
    const conflicting = buildVenueDraft(venue, signals({ capacityNumbers: [90] }), llm(40)).rooms[0];
    const regexOnly = buildVenueDraft(venue, signals({ capacityNumbers: [40] })).rooms[0];
    const estimate = buildVenueDraft({ ...venue, website: undefined }, null).rooms[0];
    expect([conflicting.confidenceSource, conflicting.confidenceFeatures]).toEqual(["both", null]);
    expect([regexOnly.confidenceSource, regexOnly.confidenceFeatures]).toEqual(["regex", null]);
    expect([estimate.confidenceSource, estimate.confidenceFeatures]).toEqual(["estimate", null]);
  });
});
