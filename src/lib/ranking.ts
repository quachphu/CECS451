import fitPriors from "@/data/fit-priors.json";
import { categoryBucket, type CategoryBucket } from "@/lib/category-bucket";
import { CAPACITY_TRUST_REASONS, PRICE_TRUST_QUALIFIERS } from "@/lib/trust-labels";
import type { CommuteMode, CommuteResult } from "@/lib/geo/commute";
import type { RoomStyle, TrustLevel, VenuePhotoRow, VenueRoomRow, VenueRow } from "@/lib/supabase/types";

export type VenueWithRelations = VenueRow & {
  rooms: VenueRoomRow[];
  photos: VenuePhotoRow[];
};

export type SearchCriteria = {
  headcount: number;
  maxCommuteMinutes: number;
  commuteMode: CommuteMode;
  style?: RoomStyle;
};

export type RankedVenue = {
  venue: VenueWithRelations;
  bestRoom: VenueRoomRow;
  commuteMinutes: number;
  commuteMiles: number;
  commuteEstimated: boolean;
  score: number;
  reasons: string[];
  /** Probability the venue really has a space that fits the group (expected-utility ranking). */
  pFit?: number;
};

// Ordered by strength of evidence, not by how confident the data feels:
// - confirmed_by_planner: a human phoned the venue and reported the answer.
// - verified: a figure printed on the venue's own private-dining page.
// - likely: the venue confirms private events but publishes no number.
// - ai_extracted: the venue's own words, but read by a model rather than
//   matched verbatim, so it must not outrank a verbatim figure.
const TRUST_WEIGHT: Record<TrustLevel, number> = {
  confirmed_by_planner: 1,
  verified: 0.9,
  likely: 0.6,
  ai_extracted: 0.45,
  unverified: 0.3,
};

/**
 * How many results rest on evidence a planner doesn't need to re-check by
 * phone, for the "N of M results are confirmed" readout during search.
 *
 * Deliberately excludes `likely` and `ai_extracted`. Both are useful signals,
 * neither is confirmation, and counting them would turn the one number a
 * planner uses to gauge the list's reliability into marketing.
 */
export function countConfirmedCapacities(results: RankedVenue[]): number {
  return results.filter(
    (r) => r.bestRoom.capacity_trust === "verified" || r.bestRoom.capacity_trust === "confirmed_by_planner"
  ).length;
}

/** Penalty for sending a planner to a venue that turns out not to fit (in units of U). */
export const LAMBDA = 0.25;
/** Below this probability of fitting, a venue isn't worth a planner's call. */
export const MIN_PFIT = 0.2;
/**
 * A non-estimate room smaller than the group, believed at least this much, is
 * strong evidence the venue doesn't fit — excluded outright, as before.
 */
const STRONG_EVIDENCE = 0.85;
/** Capacity fit credited to an estimate room, whose number is ignored. */
const NEUTRAL_FIT = 0.5;

type FitPrior = { h50: number; scale: number };
const PRIORS = fitPriors as { floor: number; ceil: number; buckets: Record<CategoryBucket, FitPrior> };

/**
 * q: the base rate that a venue of this category has a private space holding
 * `headcount` guests, from src/data/fit-priors.json (placeholder constants).
 */
export function priorFit(category: string, headcount: number): number {
  const { h50, scale } = PRIORS.buckets[categoryBucket(category)];
  const q = 1 / (1 + Math.exp((headcount - h50) / scale));
  return Math.min(PRIORS.ceil, Math.max(PRIORS.floor, q));
}

/** How much a room's capacity figure is believed; old rows fall back to the tier weight. */
function capacityBelief(room: VenueRoomRow): number {
  return room.capacity_confidence ?? TRUST_WEIGHT[room.capacity_trust];
}

type RoomChoice = { room: VenueRoomRow; fits: boolean };

/**
 * The smallest non-estimate room that holds the group (as before); failing
 * that, an estimate room (its number is ignored); failing that, the largest
 * non-estimate room, which is too small.
 */
function chooseRoom(rooms: VenueRoomRow[], headcount: number): RoomChoice | null {
  const real = rooms.filter((r) => !r.is_estimate);
  // Prefer the smallest room that still fits — a 50-person group in a
  // 60-cap room reads as "the right size"; the same group in a 1500-cap
  // ballroom is technically fine but a worse experiential fit.
  const fitting = real.filter((r) => r.max_capacity >= headcount).sort((a, b) => a.max_capacity - b.max_capacity);
  if (fitting.length > 0) return { room: fitting[0], fits: true };

  const estimate = rooms.find((r) => r.is_estimate);
  if (estimate) return { room: estimate, fits: false };

  const largest = [...real].sort((a, b) => b.max_capacity - a.max_capacity)[0];
  return largest ? { room: largest, fits: false } : null;
}

/**
 * P(the venue really fits the group): believe the room's figure with
 * probability p, otherwise fall back to the base rate q. An estimate room's
 * number carries no information, so it's q alone.
 */
function probabilityOfFit(room: VenueRoomRow, fits: boolean, q: number): number {
  if (room.is_estimate) return q;
  const p = capacityBelief(room);
  return p * (fits ? 1 : 0) + (1 - p) * q;
}

function styleScore(roomStyle: RoomStyle, requested?: RoomStyle): number {
  if (!requested || requested === "either" || roomStyle === "either") return 1;
  return roomStyle === requested ? 1 : 0.4;
}

function buildReasons(
  venue: VenueWithRelations,
  room: VenueRoomRow,
  fits: boolean,
  pFit: number,
  commuteMinutes: number,
  criteria: SearchCriteria,
  commuteEstimated: boolean
): string[] {
  const reasons: string[] = [];
  const modeLabel = criteria.commuteMode === "walk" ? "walk" : "drive";
  reasons.push(
    `${Math.round(commuteMinutes)} min ${modeLabel}${commuteEstimated ? " (estimated)" : ""} — under your ${criteria.maxCommuteMinutes} min max`
  );

  if (room.is_estimate) {
    reasons.push(`No published capacity — call to confirm it can host ${criteria.headcount}`);
  } else if (!fits) {
    reasons.push(
      `Largest listed space (${room.room_name}) holds up to ${room.max_capacity} — may be too small for ${criteria.headcount}; worth a call`
    );
  } else {
    reasons.push(`Fits ${criteria.headcount} in ${room.room_name} (up to ${room.max_capacity}${room.min_capacity ? ` from ${room.min_capacity}` : ""})`);
  }

  reasons.push(`About ${Math.round(pFit * 100)}% likely to fit your group`);

  reasons.push(CAPACITY_TRUST_REASONS[room.capacity_trust]);

  if (criteria.style && criteria.style !== "either" && room.style !== "either") {
    reasons.push(
      room.style === criteria.style
        ? `${room.style === "reception" ? "Reception" : "Seated"}-style room matches what you're looking for`
        : `Room is set up ${room.style}-style, not ${criteria.style}-style — ask about reconfiguring`
    );
  }

  if (venue.min_spend_usd != null) {
    reasons.push(`Minimum spend ~$${venue.min_spend_usd.toLocaleString()} (${PRICE_TRUST_QUALIFIERS[venue.min_spend_trust]})`);
  } else if (venue.price_tier) {
    reasons.push(`Price signal: ${venue.price_tier} (${PRICE_TRUST_QUALIFIERS[venue.price_tier_trust]})`);
  }

  return reasons;
}

/**
 * Filters venues to ones within the commute cutoff that plausibly fit, then
 * ranks them by expected utility (maximum expected utility, Russell & Norvig
 * ch. 16 [P7]):
 *
 *   U     = 0.5·commute + 0.35·capacityFit + 0.15·style
 *   score = pFit·U − (1 − pFit)·LAMBDA
 *
 * pFit is the probability the venue really has a space for the group, so a
 * venue is credited with its utility only in proportion to how much its
 * capacity is believed, and charged LAMBDA for the wasted call when it isn't.
 * A guessed capacity can no longer buy a tight-fit bonus: its number is
 * ignored and only the base rate counts.
 *
 * Ties break on pFit, then shorter commute, then name, so the order is
 * deterministic regardless of the order the database returned rows in.
 */
export function rankVenues(
  criteria: SearchCriteria,
  venues: VenueWithRelations[],
  commutes: Map<string, CommuteResult>
): RankedVenue[] {
  const ranked: RankedVenue[] = [];

  for (const venue of venues) {
    const commute = commutes.get(venue.id);
    if (!commute) continue;

    const commuteMinutes = commute.durationSeconds / 60;
    if (commuteMinutes > criteria.maxCommuteMinutes) continue;

    const choice = chooseRoom(venue.rooms, criteria.headcount);
    if (!choice) continue;
    const { room: bestRoom, fits } = choice;

    // Strong evidence it doesn't fit: the venue's own (believed) figure is too small.
    if (!fits && !bestRoom.is_estimate && capacityBelief(bestRoom) >= STRONG_EVIDENCE) continue;

    const q = priorFit(venue.category, criteria.headcount);
    const pFit = probabilityOfFit(bestRoom, fits, q);
    if (pFit < MIN_PFIT) continue;

    const commuteScoreValue = Math.max(0, 1 - commuteMinutes / criteria.maxCommuteMinutes);
    const rawCapacityFit = fits
      ? 1 - Math.min(1, (bestRoom.max_capacity - criteria.headcount) / Math.max(bestRoom.max_capacity, 1))
      : bestRoom.is_estimate
        ? NEUTRAL_FIT
        : 0;
    const style = styleScore(bestRoom.style, criteria.style);

    const utility = 0.5 * commuteScoreValue + 0.35 * rawCapacityFit + 0.15 * style;
    const score = pFit * utility - (1 - pFit) * LAMBDA;

    ranked.push({
      venue,
      bestRoom,
      commuteMinutes,
      commuteMiles: commute.distanceMeters / 1609.34,
      commuteEstimated: commute.estimated,
      score,
      pFit,
      reasons: buildReasons(venue, bestRoom, fits, pFit, commuteMinutes, criteria, commute.estimated),
    });
  }

  return ranked.sort(
    (a, b) =>
      b.score - a.score ||
      (b.pFit ?? 0) - (a.pFit ?? 0) ||
      a.commuteMinutes - b.commuteMinutes ||
      a.venue.name.localeCompare(b.venue.name)
  );
}
