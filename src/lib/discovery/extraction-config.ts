/**
 * Settings shared by the app's extraction and the offline training scripts
 * (scripts/data/). The training data is only valid for the app if both read
 * pages the same way, so these live in one place and are imported by both.
 */

/** Independent LLM reads per venue (self-consistency, Wang et al. 2022 [P7]). */
export const SELF_CONSISTENCY_K = 3;
/** Sampling temperature for those reads; 0 would make the reads identical. */
export const SELF_CONSISTENCY_TEMPERATURE = 0.7;
/** Two reads within ±10% of each other count as the same capacity. */
export const SELF_CONSISTENCY_TOLERANCE = 0.1;
/** Minimum successful reads for self-consistency to be defined. */
export const MIN_SUCCESSFUL_READS = 2;

/** A regex candidate within ±20% of the LLM figure counts as agreement. */
export const REGEX_AGREEMENT_TOLERANCE = 0.2;
/** `competing_numbers` is capped so one menu-heavy page can't dominate the feature. */
export const COMPETING_NUMBERS_CAP = 10;

/**
 * xAI model for every Grok call. The deployed name changes as xAI releases
 * models, so it comes from XAI_MODEL; scripts verify it against GET /v1/models
 * before spending anything.
 */
export const DEFAULT_XAI_MODEL = "grok-4.7";

export function xaiModel(): string {
  return process.env.XAI_MODEL?.trim() || DEFAULT_XAI_MODEL;
}

/** xAI API base (OpenAI-compatible). Overridable for a compatible proxy or an offline test double. */
export function xaiBaseUrl(): string {
  return (process.env.XAI_BASE_URL?.trim() || "https://api.x.ai/v1").replace(/\/+$/, "");
}
