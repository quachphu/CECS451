import { describe, expect, it } from "vitest";
import {
  cohenKappa,
  dcgAtK,
  expectedCalibrationError,
  ndcgAtK,
  precisionRecallF1,
  withinTolerance,
} from "../../eval/metrics";
import { v0Rooms } from "../../eval/baselines";

// Reference values were computed with scikit-learn 1.9.1 (ndcg_score given
// gains 2^rel − 1, cohen_kappa_score) and with scripts/train_confidence.py's
// expected_calibration_error on the same inputs.
describe("eval metrics (cross-checked with scikit-learn)", () => {
  it("NDCG@5 matches sklearn ndcg_score on hand cases", () => {
    expect(ndcgAtK([3, 2, 3, 0, 1, 2], [3, 2, 3, 0, 1, 2], 5)).toBeCloseTo(0.8755943764161996, 10);
    expect(ndcgAtK([0, 0, 1, 3, 2], [0, 0, 1, 3, 2], 5)).toBeCloseTo(0.49775356376533825, 10);
    expect(ndcgAtK([3, 2, 1, 0], [3, 2, 1, 0], 5)).toBe(1);
  });

  it("uses exponential gains (2^rel − 1) / log2(i + 1)", () => {
    expect(dcgAtK([3, 1], 5)).toBeCloseTo(7 / 1 + 1 / Math.log2(3), 12);
  });

  it("returns 0 NDCG when nothing judged is relevant", () => {
    expect(ndcgAtK([0, 0], [0, 0], 5)).toBe(0);
  });

  it("Cohen's kappa matches sklearn cohen_kappa_score", () => {
    expect(cohenKappa([1, 1, 0, 1, 0, 0, 1, 1], [1, 0, 0, 1, 0, 1, 1, 1]).kappa).toBeCloseTo(0.4666666666666667, 12);
    expect(cohenKappa([1, 1, 1, 1], [1, 1, 1, 0]).kappa).toBe(0);
  });

  it("ECE matches the Python trainer's implementation", () => {
    const conf = [0.95, 0.9, 0.85, 0.7, 0.62, 0.55, 0.3, 0.25, 0.1, 0.0];
    const correct = [1, 1, 0, 1, 0, 1, 0, 0, 0, 0] as const;
    expect(expectedCalibrationError(conf, [...correct])).toBeCloseTo(0.222, 10);
  });

  it("computes precision/recall/F1 and the ±10% tolerance", () => {
    expect(precisionRecallF1([true, true, false, false], [true, false, true, false])).toEqual({
      precision: 0.5,
      recall: 0.5,
      f1: 0.5,
    });
    expect(withinTolerance(44, 40)).toBe(true);
    expect(withinTolerance(45, 40)).toBe(false);
  });
});

describe("v0 baseline", () => {
  it("reproduces the original Garden Room defect: max 180, min 2, verified", () => {
    const text = "Our main dining room seats 180 guests. Book a table for 2 people. The Garden Room holds 40 guests.";
    expect(v0Rooms(text, true, "restaurant")[0]).toMatchObject({
      maxCapacity: 180,
      minCapacity: 2,
      capacityTrust: "verified",
    });
  });
});
