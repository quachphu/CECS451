/**
 * Capacity confidence: the probability that a stored room capacity is right.
 *
 * A logistic model over evidence features — the same form Platt scaling uses
 * to turn a score into a probability [P6], and the model class
 * Niculescu-Mizil & Caruana found well calibrated on small data [P6]. The
 * shipped coefficients (src/data/confidence-model.json, version
 * "placeholder-0") are hand-set to roughly reproduce the old tier weights;
 * scripts/train_confidence.py refits them from labelled data with
 * scikit-learn's LogisticRegression [D9] and reports Expected Calibration Error
 * [P4, P5].
 *
 * Computed once, at write time (buildVenueDraft), and stored in
 * venue_rooms.capacity_confidence — the search path does no inference.
 */
import model from "@/data/confidence-model.json";
import { categoryBucket } from "@/lib/category-bucket";

export type ConfidenceSource = "regex" | "llm" | "both" | "estimate" | "planner";

export type ConfidenceFeatures = {
  /** How the figure was obtained. */
  source: ConfidenceSource;
  /** |regex − llm| / max(regex, llm) when both reads produced a figure for this room. */
  agreementSpread: number | null;
  privateDiningPageFound: boolean;
  /** The figure is backed by a sentence verified to be on the page. */
  grounded: boolean;
  /** Other plausible capacity figures on the site that this room didn't use. */
  competingCandidates: number;
  /** The page attached a room name to the figure. */
  hasRoomHint: boolean;
  renderedWithJs: boolean;
  category: string;
};

export type ConfidenceModel = {
  version: string;
  intercept: number;
  weights: Record<string, number>;
};

export const CONFIDENCE_MODEL: ConfidenceModel = model;

/** Planner confirmations are set to this directly rather than scored. */
export const PLANNER_CONFIDENCE = 0.98;

/**
 * One-hot/numeric encoding shared with scripts/train_confidence.py — keep the
 * two in step. Unknown keys simply have weight 0.
 */
export function encodeConfidenceFeatures(f: ConfidenceFeatures): Record<string, number> {
  return {
    [`source=${f.source}`]: 1,
    agreementSpread: f.agreementSpread ?? 0,
    privateDiningPageFound: Number(f.privateDiningPageFound),
    grounded: Number(f.grounded),
    competingCandidates: f.competingCandidates,
    hasRoomHint: Number(f.hasRoomHint),
    renderedWithJs: Number(f.renderedWithJs),
    [`category=${categoryBucket(f.category)}`]: 1,
  };
}

function sigmoid(z: number): number {
  return 1 / (1 + Math.exp(-z));
}

/** σ(intercept + w·x), rounded to 3 decimals for storage. */
export function scoreConfidence(f: ConfidenceFeatures, m: ConfidenceModel = CONFIDENCE_MODEL): number {
  const x = encodeConfidenceFeatures(f);
  const z = Object.entries(x).reduce((sum, [name, value]) => sum + (m.weights[name] ?? 0) * value, m.intercept);
  return Math.round(sigmoid(z) * 1000) / 1000;
}

/** The feature log persisted to venue_rooms.confidence_features, tagged with the model version. */
export function featureLog(
  f: ConfidenceFeatures,
  m: ConfidenceModel = CONFIDENCE_MODEL
): Record<string, string | number | boolean | null> {
  return { ...f, modelVersion: m.version };
}
