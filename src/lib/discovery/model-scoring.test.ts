import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import confidenceJson from "@/data/confidence-model.json";
import discoveryJson from "@/data/discovery-prior.json";
import fitJson from "@/data/fit-priors.json";
import { BUCKETS } from "@/lib/discovery/category-buckets";
import { CONFIDENCE_FEATURE_ORDER, DISCOVERY_POST_FETCH_ORDER, DISCOVERY_PRE_FETCH_ORDER } from "@/lib/discovery/features";
import {
  fitPrior,
  isTrainedVersion,
  loadFitPrior,
  loadModel,
  loadTrainedConfidenceModel,
  loadTrainedDiscoveryPrior,
  loadTrainedFitPrior,
  ModelFormatError,
  scoreLogistic,
} from "@/lib/discovery/model-scoring";

type Fixture = {
  source: string;
  tolerance: number;
  model_versions: Record<string, string | null>;
  models: Record<string, { model: unknown; rows: Array<{ x: Record<string, number | null>; p: number }> }>;
  fit_prior: { model: unknown; points: Array<{ bucket: string; h: number; q: number }> } | null;
};
const fixture: Fixture = JSON.parse(
  readFileSync(new URL("./__fixtures__/model-parity.json", import.meta.url), "utf8")
);

const valid = {
  feature_order: ["a", "b"],
  impute_median: { a: 1, b: 0 },
  scaler: { a: { mean: 1, std: 2 } },
  coef: [0.5, -1],
  intercept: 0.25,
  calibration: null,
};

describe("loadModel", () => {
  it("accepts a well-formed export", () => {
    expect(loadModel(valid).feature_order).toEqual(["a", "b"]);
  });

  it.each([
    ["no feature order", { ...valid, feature_order: [] }],
    ["coef length mismatch", { ...valid, coef: [1] }],
    ["non-finite coefficient", { ...valid, coef: [1, Number.NaN] }],
    ["non-finite intercept", { ...valid, intercept: Infinity }],
    ["missing median", { ...valid, impute_median: { a: 1 } }],
    ["zero std", { ...valid, scaler: { a: { mean: 0, std: 0 } } }],
    ["scaler for unknown feature", { ...valid, scaler: { z: { mean: 0, std: 1 } } }],
    ["bad calibration", { ...valid, calibration: { a: Number.NaN, b: 0 } }],
  ])("rejects %s", (_label, json) => {
    expect(() => loadModel(json)).toThrow(ModelFormatError);
  });
});

describe("scoreLogistic", () => {
  it("imputes, scales, applies the logistic and the optional Platt step", () => {
    const m = loadModel(valid);
    // a missing -> median 1 -> scaled 0; b = 1: z = 0.25 - 1
    expect(scoreLogistic(m, { a: null, b: 1 })).toBeCloseTo(1 / (1 + Math.exp(0.75)), 12);
    const cal = loadModel({ ...valid, calibration: { a: -2, b: 0.5 } });
    expect(scoreLogistic(cal, { a: 3, b: 0 })).toBeCloseTo(1 / (1 + Math.exp(-2 * 0.75 + 0.5)), 12);
  });
});

describe("fitPrior", () => {
  const m = loadFitPrior({
    version: "trained-x",
    headcounts: [10, 20, 50],
    global: { q: [0.9, 0.6, 0.2] },
    buckets: { hotel: { q: [1, 0.8, 0.5] } },
  });

  it("interpolates linearly and clamps to the grid ends", () => {
    expect(fitPrior(m, "hotel", 15)).toBeCloseTo(0.9, 12);
    expect(fitPrior(m, "hotel", 35)).toBeCloseTo(0.65, 12);
    expect(fitPrior(m, "hotel", 5)).toBe(1);
    expect(fitPrior(m, "hotel", 500)).toBe(0.5);
    expect(fitPrior(m, "no_such_bucket", 20)).toBe(0.6);
  });

  it("rejects a malformed table", () => {
    expect(() => loadFitPrior({ headcounts: [10, 5], global: { q: [1, 1] }, buckets: {} })).toThrow(ModelFormatError);
    expect(() => loadFitPrior({ headcounts: [10, 20], global: { q: [1.2, 1] }, buckets: {} })).toThrow(ModelFormatError);
  });
});

describe("Python/TypeScript parity (ml/export_fixtures.py)", () => {
  const entries = Object.entries(fixture.models);

  it("covers the confidence model and both discovery variants", () => {
    expect(entries.map(([name]) => name)).toEqual(
      expect.arrayContaining(["confidence", "discovery_pre_fetch", "discovery_post_fetch"])
    );
  });

  it.each(entries)("%s matches scikit-learn's predict_proba within 1e-6", (_name, { model, rows }) => {
    const m = loadModel(model);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(Math.abs(scoreLogistic(m, row.x) - row.p)).toBeLessThanOrEqual(fixture.tolerance);
  });

  it("uses the shared feature orders", () => {
    const conf = loadModel(fixture.models.confidence.model);
    expect(CONFIDENCE_FEATURE_ORDER).toEqual(expect.arrayContaining(conf.feature_order));
    expect(loadModel(fixture.models.discovery_pre_fetch.model).feature_order).toEqual([...DISCOVERY_PRE_FETCH_ORDER]);
    expect(loadModel(fixture.models.discovery_post_fetch.model).feature_order).toEqual([...DISCOVERY_POST_FETCH_ORDER]);
  });

  it("matches the fit-prior interpolation", () => {
    expect(fixture.fit_prior).not.toBeNull();
    const m = loadFitPrior(fixture.fit_prior!.model);
    expect(Object.keys(m.buckets).sort()).toEqual([...BUCKETS].sort());
    for (const p of fixture.fit_prior!.points) expect(Math.abs(fitPrior(m, p.bucket, p.h) - p.q)).toBeLessThanOrEqual(1e-9);
  });
});

describe("shipped model files", () => {
  it("load, and a trained file was exported together with its parity rows", () => {
    for (const [name, json] of [
      ["confidence", confidenceJson],
      ["discovery", discoveryJson],
      ["fit_prior", fitJson],
    ] as const) {
      if (!isTrainedVersion(json)) continue;
      expect(fixture.model_versions[name]).toBe((json as { version: string }).version);
    }
    expect(() => loadTrainedConfidenceModel(confidenceJson)).not.toThrow();
    expect(() => loadTrainedDiscoveryPrior(discoveryJson)).not.toThrow();
    expect(() => loadTrainedFitPrior(fitJson)).not.toThrow();
  });
});
