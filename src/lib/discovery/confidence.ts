/**
 * Capacity confidence: P(a room's stated capacity is within 10% of the truth).
 *
 * Logistic regression [D9] trained offline by ml/train_confidence.py on rooms
 * the extraction model read, labeled by a teacher model and checked by people,
 * and exported to src/data/confidence-model.json. Its features come from
 * features.ts, the same function that built the training rows, so training
 * and serving cannot drift apart.
 *
 * Scored once at write time (buildVenueDraft) and stored with the model
 * version in venue_rooms.capacity_confidence / confidence_features; the search
 * path does no inference. Only a room whose figure is the extraction model's
 * own modal read gets a score, since that is what each training row measured.
 * Regex-only figures, estimates and rooms showing a different figure keep the
 * v0 tier weight.
 *
 * While the model file is still a placeholder, no room is scored: ranking uses
 * the v0 tier weights and the UI does not show "% likely to fit".
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

/** P(capacity is right), rounded to 3 decimals for storage; null without a trained model or features. */
export function scoreRoomConfidence(
  features: ConfidenceFeatures | null,
  model: LogisticModel | null = TRAINED_CONFIDENCE_MODEL
): number | null {
  if (!model || !features) return null;
  return Math.round(scoreLogistic(model, encodeConfidenceFeatures(features)) * 1000) / 1000;
}

/**
 * What venue_rooms.confidence_features stores: the source, the encoded
 * features when the room has them, and the model version that scored it
 * ("none" when no trained model was loaded).
 */
export function featureLog(
  source: ConfidenceSource,
  features: ConfidenceFeatures | null,
  model: LogisticModel | null = TRAINED_CONFIDENCE_MODEL
): Record<string, string | number | boolean | null> {
  return { source, ...(features ? encodeConfidenceFeatures(features) : {}), modelVersion: model?.version ?? "none" };
}
