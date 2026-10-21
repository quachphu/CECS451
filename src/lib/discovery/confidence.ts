/**
 * Capacity confidence: P(the displayed number is within 10% of the truth).
 *
 * Logistic regression trained offline by ml/train_candidates.py, one row per
 * number on a saved page, exported to src/data/confidence-model.json. The
 * displayed number is chosen by votes plus a grounded quote plus a regex hit
 * (buildVenueDraft). This model only scores that number, at write time.
 * Category estimates have no number on the page and are not scored.
 *
 * A stored probability is capped just below PLANNER_CONFIDENCE so a
 * planner-confirmed room stays strictly above any model-scored room.
 */
import modelJson from "@/data/confidence-model.json";
import { encodeConfidenceFeatures, type ConfidenceFeatures } from "@/lib/discovery/features";
import { loadTrainedConfidenceModel, scoreLogistic, type LogisticModel } from "@/lib/discovery/model-scoring";

export type { ConfidenceFeatures };

/** How a stored figure was obtained, recorded with every room. */
export type ConfidenceSource = "llm" | "both" | "regex" | "estimate" | "planner";

/** The trained model, or null while src/data/confidence-model.json is a placeholder. */
export const TRAINED_CONFIDENCE_MODEL: LogisticModel | null = loadTrainedConfidenceModel(modelJson);

/** Planner confirmations are set to this directly rather than scored. */
export const PLANNER_CONFIDENCE = 0.98;

/**
 * Model probabilities are stored at or below this. 0.979 is the largest
 * 3-decimal value strictly under PLANNER_CONFIDENCE (0.98).
 */
export const MODEL_PROBABILITY_CAP = 0.979;

/**
 * Displayed trust for a room this model scored. Fixed before looking at gold:
 * 0.90 and above is verified, 0.60 up to 0.90 is likely, below 0.60 is unverified.
 */
export const MODEL_TRUST_VERIFIED_AT = 0.9;
export const MODEL_TRUST_LIKELY_AT = 0.6;

export function trustFromConfidence(probability: number): "verified" | "likely" | "unverified" {
  if (probability >= MODEL_TRUST_VERIFIED_AT) return "verified";
  if (probability >= MODEL_TRUST_LIKELY_AT) return "likely";
  return "unverified";
}

/** True when ranking is using this room's stored model probability rather than a tier weight. */
export function roomUsesModelScore(room: {
  capacity_confidence?: number | null;
  confidence_features?: { modelVersion?: string; source?: string } | null;
}): boolean {
  const model = TRAINED_CONFIDENCE_MODEL;
  if (!model || room.capacity_confidence == null) return false;
  const features = room.confidence_features;
  if (!features || features.modelVersion !== model.version) return false;
  return features.source !== "planner" && features.source !== "estimate";
}

function capped(p: number): number {
  return Math.round(Math.min(p, MODEL_PROBABILITY_CAP) * 1000) / 1000;
}

/**
 * P(the displayed candidate number is right). Null when no trained model is
 * loaded or the row is missing a feature the model was trained on.
 */
export function scoreCandidateConfidence(
  features: Record<string, number> | null,
  model: LogisticModel | null = TRAINED_CONFIDENCE_MODEL
): number | null {
  if (!model || !features) return null;
  if (model.feature_order.some((name) => !Number.isFinite(features[name]))) return null;
  return capped(scoreLogistic(model, features));
}

/**
 * Scores the older room-level feature vector. Returns null when the loaded
 * model was trained on candidate numbers instead, so those features are not
 * silently median-imputed.
 */
export function scoreRoomConfidence(
  features: ConfidenceFeatures | null,
  model: LogisticModel | null = TRAINED_CONFIDENCE_MODEL
): number | null {
  if (!model || !features) return null;
  const encoded = encodeConfidenceFeatures(features);
  if (model.feature_order.some((name) => !(name in encoded))) return null;
  return capped(scoreLogistic(model, encoded));
}

/**
 * What venue_rooms.confidence_features stores: the source, the encoded
 * features when the room has them, and the model version that scored it
 * ("none" when no trained model was loaded).
 */
export function featureLog(
  source: ConfidenceSource,
  features: ConfidenceFeatures | Record<string, number> | null,
  model: LogisticModel | null = TRAINED_CONFIDENCE_MODEL
): Record<string, string | number | boolean | null> {
  const encoded =
    features == null
      ? {}
      : "regex_status" in features
        ? encodeConfidenceFeatures(features as ConfidenceFeatures)
        : features;
  return { source, ...encoded, modelVersion: model?.version ?? "none" };
}
