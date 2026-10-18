/**
 * The one feature function for the trained models.
 *
 * The app calls this at write time and the training scripts call it when they
 * build their tables (scripts/data/04_extract_student.ts, 08_build_tables.ts).
 * Python never recomputes a feature; it reads the values produced here. One
 * implementation means the model is scored on exactly the inputs it was
 * trained on (no train/serve skew).
 */
import { REFERENCE_BUCKET, BUCKETS, type Bucket } from "@/lib/discovery/category-buckets";
import {
  COMPETING_NUMBERS_CAP,
  MIN_SUCCESSFUL_READS,
  REGEX_AGREEMENT_TOLERANCE,
  SELF_CONSISTENCY_TOLERANCE,
} from "@/lib/discovery/extraction-config";
import { canonicalRoomName, normalizeRoomKey, type RoomStyleLabel } from "@/lib/discovery/room-normalize";
import { extractCapacityCandidates } from "@/lib/discovery/scraper";

// ---------------------------------------------------------------- confidence

/** One room as one LLM read returned it, after the grounding check. */
export type ReadRoom = {
  roomName: string;
  style: RoomStyleLabel;
  maxCapacity: number;
  minCapacity: number | null;
  evidenceQuote: string;
  grounded: boolean;
};

/** A room across all k reads. */
export type AggregatedRoom = {
  roomKey: string;
  roomName: string;
  style: RoomStyleLabel;
  /** The modal capacity. */
  capacity: number;
  minCapacity: number | null;
  evidenceQuote: string;
  /** Grounding of the read that supplied the modal value. */
  grounded: boolean;
  /** This room's capacity in each successful read, null where that read didn't return it. */
  reads: Array<number | null>;
  /** Share of successful reads agreeing with the mode (±10%); null below MIN_SUCCESSFUL_READS. */
  selfConsistency: number | null;
};

export function withinRelative(a: number, b: number, tolerance: number): boolean {
  return Math.abs(a - b) <= tolerance * Math.max(Math.abs(a), Math.abs(b));
}

/**
 * The modal value among `values` (nulls are reads that didn't produce one):
 * the value with the most reads within ±tolerance of it; ties go to the
 * earliest read. Returns how many reads agree with it.
 */
export function modalValue(
  values: Array<number | null>,
  tolerance = SELF_CONSISTENCY_TOLERANCE
): { value: number; agreeing: number; index: number } | null {
  let best: { value: number; agreeing: number; index: number } | null = null;
  values.forEach((v, index) => {
    if (v == null) return;
    const agreeing = values.filter((w) => w != null && withinRelative(v, w, tolerance)).length;
    if (!best || agreeing > best.agreeing) best = { value: v, agreeing, index };
  });
  return best;
}

/**
 * Merges k reads (null = a failed read) into one row per room. Rooms are
 * matched across reads by normalized name and style; a room missing from a
 * successful read counts against its self-consistency.
 */
export function aggregateReads(reads: Array<ReadRoom[] | null>): AggregatedRoom[] {
  const successful = reads.filter((r): r is ReadRoom[] => r != null);
  const keys: string[] = [];
  const byKey = new Map<string, Array<ReadRoom | null>>();
  successful.forEach((rooms, readIndex) => {
    for (const room of rooms) {
      const key = `${normalizeRoomKey(room.roomName) || "unnamed"}|${room.style}`;
      if (!byKey.has(key)) {
        byKey.set(key, Array(successful.length).fill(null));
        keys.push(key);
      }
      const slots = byKey.get(key)!;
      slots[readIndex] ??= room;
    }
  });

  return keys.map((key) => {
    const slots = byKey.get(key)!;
    const values = slots.map((r) => r?.maxCapacity ?? null);
    const mode = modalValue(values)!;
    const rep = slots[mode.index]!;
    return {
      roomKey: key,
      roomName: canonicalRoomName(rep.roomName),
      style: rep.style,
      capacity: mode.value,
      minCapacity: rep.minCapacity,
      evidenceQuote: rep.evidenceQuote,
      grounded: rep.grounded,
      reads: values,
      selfConsistency: successful.length >= MIN_SUCCESSFUL_READS ? mode.agreeing / successful.length : null,
    };
  });
}

export type RegexStatus = "agree" | "disagree" | "absent";

/**
 * "agree" when a regex candidate is within ±20% of the LLM figure (relative to
 * the LLM figure); "absent" when the regex found none.
 */
export function regexStatus(value: number, candidateValues: number[]): RegexStatus {
  if (candidateValues.length === 0) return "absent";
  return candidateValues.some((c) => Math.abs(c - value) <= REGEX_AGREEMENT_TOLERANCE * value) ? "agree" : "disagree";
}

/** Distinct capacity-like figures in the text the model read, capped at 10. */
export function competingNumbers(inputText: string): number {
  return Math.min(COMPETING_NUMBERS_CAP, new Set(extractCapacityCandidates(inputText).map((c) => c.value)).size);
}

export type ConfidenceFeatures = {
  self_consistency: number;
  regex_status: RegexStatus;
  grounded: boolean;
  competing_numbers: number;
  private_page_found: boolean;
};

/** Column order of the confidence model; regex_status "disagree" is the baseline. */
export const CONFIDENCE_FEATURE_ORDER = [
  "self_consistency",
  "regex_agree",
  "regex_absent",
  "grounded",
  "competing_numbers",
  "private_page_found",
] as const;

/**
 * Features for one LLM-extracted room. Null when self-consistency is undefined
 * (fewer than two successful reads); such rooms aren't scored by the model.
 */
export function roomConfidenceFeatures(
  room: Pick<AggregatedRoom, "capacity" | "grounded" | "selfConsistency">,
  inputText: string,
  privateDiningPageFound: boolean
): ConfidenceFeatures | null {
  if (room.selfConsistency == null) return null;
  const candidates = extractCapacityCandidates(inputText).map((c) => c.value);
  return {
    self_consistency: room.selfConsistency,
    regex_status: regexStatus(room.capacity, candidates),
    grounded: room.grounded,
    competing_numbers: competingNumbers(inputText),
    private_page_found: privateDiningPageFound,
  };
}

/** The numeric row the model sees, keyed by CONFIDENCE_FEATURE_ORDER. */
export function encodeConfidenceFeatures(
  f: ConfidenceFeatures
): Record<(typeof CONFIDENCE_FEATURE_ORDER)[number], number> {
  return {
    self_consistency: f.self_consistency,
    regex_agree: f.regex_status === "agree" ? 1 : 0,
    regex_absent: f.regex_status === "absent" ? 1 : 0,
    grounded: f.grounded ? 1 : 0,
    competing_numbers: f.competing_numbers,
    private_page_found: f.private_page_found ? 1 : 0,
  };
}

// ----------------------------------------------------------------- discovery

export const DISCOVERY_NAME_KEYWORDS = [
  "steakhouse",
  "grill",
  "tavern",
  "hall",
  "club",
  "hotel",
  "pizza",
  "cafe",
  "express",
  "bistro",
] as const;

export const NON_REFERENCE_BUCKETS = BUCKETS.filter((b) => b !== REFERENCE_BUCKET);

/** Pre-fetch columns: available before any page is read (ranking candidates). */
export const DISCOVERY_PRE_FETCH_ORDER = [
  ...NON_REFERENCE_BUCKETS.map((b) => `bucket_${b}`),
  "price_level",
  "price_missing",
  "rating",
  "rating_missing",
  "log_reviews",
  "reviews_missing",
  ...DISCOVERY_NAME_KEYWORDS.map((k) => `name_${k}`),
] as const;

/** Post-fetch adds what the homepage reveals. */
export const DISCOVERY_POST_FETCH_ORDER = [...DISCOVERY_PRE_FETCH_ORDER, "has_external_event_link"] as const;

export type DiscoveryInput = {
  bucket: Bucket;
  name: string;
  /** Google price level 0–4, or null when Google has none (common). */
  priceLevel: number | null;
  rating: number | null;
  userRatingCount: number | null;
  /** Known only after the homepage is fetched; omit for the pre-fetch variant. */
  hasExternalEventLink?: boolean;
};

/**
 * Discovery features. Missing Google fields stay null (with a 1 in the
 * matching *_missing flag); the model's exported medians fill them in at
 * scoring time, exactly as in training.
 */
export function discoveryFeatures(input: DiscoveryInput): Record<string, number | null> {
  const name = input.name.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");
  const row: Record<string, number | null> = {};
  for (const b of NON_REFERENCE_BUCKETS) row[`bucket_${b}`] = input.bucket === b ? 1 : 0;
  row.price_level = input.priceLevel;
  row.price_missing = input.priceLevel == null ? 1 : 0;
  row.rating = input.rating;
  row.rating_missing = input.rating == null ? 1 : 0;
  row.log_reviews = input.userRatingCount == null ? null : Math.log1p(input.userRatingCount);
  row.reviews_missing = input.userRatingCount == null ? 1 : 0;
  for (const k of DISCOVERY_NAME_KEYWORDS) row[`name_${k}`] = new RegExp(`\\b${k}`).test(name) ? 1 : 0;
  if (input.hasExternalEventLink !== undefined) row.has_external_event_link = input.hasExternalEventLink ? 1 : 0;
  return row;
}
