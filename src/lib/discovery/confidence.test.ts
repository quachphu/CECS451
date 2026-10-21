import { describe, expect, it } from "vitest";
import {
  featureLog,
  MODEL_PROBABILITY_CAP,
  MODEL_TRUST_LIKELY_AT,
  MODEL_TRUST_VERIFIED_AT,
  PLANNER_CONFIDENCE,
  scoreRoomConfidence,
  TRAINED_CONFIDENCE_MODEL,
  trustFromConfidence,
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
  it("scores candidate numbers, and does not score the older room-feature vector", () => {
    expect(TRAINED_CONFIDENCE_MODEL).not.toBeNull();
    expect(scoreRoomConfidence(features)).toBeNull();
    expect(featureLog("llm", features)).toMatchObject({
      source: "llm",
      self_consistency: 1,
      regex_agree: 1,
      modelVersion: TRAINED_CONFIDENCE_MODEL!.version,
    });
  });

  it("scores with a trained model and logs its version", () => {
    // z = -0.4 + 1*(1-0.8)/0.2 + 0.5 + 1 + (-0.2)*(2-3)/2 + 0.3 = 2.5
    expect(scoreRoomConfidence(features, toy)).toBeCloseTo(1 / (1 + Math.exp(-2.5)), 3);
    expect(scoreRoomConfidence(null, toy)).toBeNull();
    expect(featureLog("regex", null, toy)).toEqual({ source: "regex", modelVersion: "trained-toy" });
  });
});

describe("model trust labels", () => {
  it("uses the cutoffs fixed at 0.90 and 0.60", () => {
    expect(MODEL_TRUST_VERIFIED_AT).toBe(0.9);
    expect(MODEL_TRUST_LIKELY_AT).toBe(0.6);
    expect(trustFromConfidence(0.9)).toBe("verified");
    expect(trustFromConfidence(0.899)).toBe("likely");
    expect(trustFromConfidence(0.6)).toBe("likely");
    expect(trustFromConfidence(0.599)).toBe("unverified");
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

  it("stores the model's probability for the number votes and a quote selected", () => {
    const [room] = buildVenueDraft(venue, signals({ capacityNumbers: [40] }), llm(40)).rooms;
    expect(room.maxCapacity).toBe(40);
    expect(room.confidenceSource).toBe("both");
    expect(room.confidenceFeatures).toMatchObject({ llm_votes: 1, regex_hit: 1, in_grounded_quote: 1 });
    expect(room.confidence).not.toBeNull();
    expect(room.confidence!).toBeLessThanOrEqual(MODEL_PROBABILITY_CAP);
    expect(room.confidence!).toBeLessThan(PLANNER_CONFIDENCE);
  });

  it("scores a displayed page number and leaves a category estimate unscored", () => {
    const conflicting = buildVenueDraft(venue, signals({ capacityNumbers: [90] }), llm(40)).rooms[0];
    const regexOnly = buildVenueDraft(venue, signals({ capacityNumbers: [40] })).rooms[0];
    const estimate = buildVenueDraft({ ...venue, website: undefined }, null).rooms[0];
    // The quote names 40 and the model voted for 40, so 40 is shown ahead of the stray 90.
    expect(conflicting.maxCapacity).toBe(40);
    expect(conflicting.confidence).not.toBeNull();
    expect(regexOnly.confidenceSource).toBe("regex");
    expect(regexOnly.confidence).not.toBeNull();
    expect(estimate.isEstimate).toBe(true);
    expect(estimate.confidence).toBeNull();
    expect(estimate.confidenceFeatures).toBeNull();
  });
});
