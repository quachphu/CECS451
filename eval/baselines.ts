/**
 * Baselines kept as pure functions so the evaluation can compare the new AI
 * core against what shipped before it (commit 95e4a8a).
 */
import type { CommuteResult } from "@/lib/geo/commute";
import type { RankedVenue, SearchCriteria, VenueWithRelations } from "@/lib/ranking";
import type { RoomStyle, TrustLevel, VenueRoomRow } from "@/lib/supabase/types";

// ---------------------------------------------------------------------------
// v0 extraction: the original "largest regex number" capacity logic.

/** The original capacity regex, unfiltered ("table for 2 people" matches). */
const V0_CAPACITY_PATTERN =
  /(?:up\s*to|seats?|accommodat(?:es|ing)|hold[s]?|for)\s*(\d{1,4})\s*(?:guests?|people|persons?|pax)/gi;

function v0EstimateByCategory(category: string): number {
  const c = category.toLowerCase();
  if (c.includes("banquet")) return 150;
  if (c.includes("night") || c.includes("club")) return 120;
  if (c.includes("bar")) return 80;
  return 60;
}

export type V0Room = {
  roomName: string;
  maxCapacity: number;
  minCapacity?: number;
  capacityTrust: TrustLevel;
  isEstimate: boolean;
};

/**
 * Capacity as v0 derived it: max = the largest number anywhere on the read
 * pages, min = the smallest, `verified` whenever a private-dining page was
 * found; otherwise a category estimate.
 */
export function v0Rooms(combinedText: string, privateDiningPageFound: boolean, category: string): V0Room[] {
  const numbers: number[] = [];
  for (const m of combinedText.matchAll(V0_CAPACITY_PATTERN)) {
    const v = parseInt(m[1] ?? "", 10);
    if (!Number.isNaN(v) && v > 0) numbers.push(v);
  }
  numbers.sort((a, b) => a - b);

  if (numbers.length > 0) {
    const max = numbers.at(-1)!;
    return [
      {
        roomName: "Private Dining / Event Space",
        maxCapacity: max,
        minCapacity: numbers[0] !== max ? numbers[0] : undefined,
        capacityTrust: privateDiningPageFound ? "verified" : "unverified",
        isEstimate: false,
      },
    ];
  }
  return [
    {
      roomName: privateDiningPageFound ? "Private events available (capacity unpublished)" : "Capacity unconfirmed",
      maxCapacity: v0EstimateByCategory(category),
      capacityTrust: privateDiningPageFound ? "likely" : "unverified",
      isEstimate: true,
    },
  ];
}

// ---------------------------------------------------------------------------
// v0 ranking: the original weighted formula.

export const V0_TRUST_WEIGHT: Record<TrustLevel, number> = {
  confirmed_by_planner: 1,
  verified: 0.9,
  likely: 0.6,
  ai_extracted: 0.45,
  unverified: 0.3,
};

function v0PickBestRoom(rooms: VenueRoomRow[], headcount: number): VenueRoomRow | null {
  const fitting = rooms.filter((r) => r.max_capacity >= headcount);
  if (fitting.length === 0) return null;
  return [...fitting].sort((a, b) => a.max_capacity - b.max_capacity)[0];
}

function v0StyleScore(roomStyle: RoomStyle, requested?: RoomStyle): number {
  if (!requested || requested === "either" || roomStyle === "either") return 1;
  return roomStyle === requested ? 1 : 0.4;
}

/**
 * score = 0.35·commute + 0.30·capacityFit·trust + 0.25·trust + 0.10·style,
 * with capacity trust counted twice and no tie-break (v0).
 */
export function v0RankVenues(
  criteria: SearchCriteria,
  venues: VenueWithRelations[],
  commutes: Map<string, CommuteResult>
): Pick<RankedVenue, "venue" | "bestRoom" | "commuteMinutes" | "score">[] {
  const ranked: Pick<RankedVenue, "venue" | "bestRoom" | "commuteMinutes" | "score">[] = [];
  for (const venue of venues) {
    const commute = commutes.get(venue.id);
    if (!commute) continue;
    const commuteMinutes = commute.durationSeconds / 60;
    if (commuteMinutes > criteria.maxCommuteMinutes) continue;
    const bestRoom = v0PickBestRoom(venue.rooms, criteria.headcount);
    if (!bestRoom) continue;

    const commuteScore = Math.max(0, 1 - commuteMinutes / criteria.maxCommuteMinutes);
    const rawFit = 1 - Math.min(1, (bestRoom.max_capacity - criteria.headcount) / Math.max(bestRoom.max_capacity, 1));
    const capacityFit = rawFit * V0_TRUST_WEIGHT[bestRoom.capacity_trust];
    const trust = V0_TRUST_WEIGHT[bestRoom.capacity_trust] * 0.7 + V0_TRUST_WEIGHT[venue.price_tier_trust] * 0.3;
    const score =
      commuteScore * 0.35 + capacityFit * 0.3 + trust * 0.25 + v0StyleScore(bestRoom.style, criteria.style) * 0.1;
    ranked.push({ venue, bestRoom, commuteMinutes, score });
  }
  return ranked.sort((a, b) => b.score - a.score);
}

/** Distance-only: everything inside the commute cutoff, nearest first. No capacity filter. */
export function distanceOnlyRank(
  criteria: SearchCriteria,
  venues: VenueWithRelations[],
  commutes: Map<string, CommuteResult>
): { venue: VenueWithRelations; commuteMinutes: number }[] {
  return venues
    .flatMap((venue) => {
      const c = commutes.get(venue.id);
      if (!c) return [];
      const commuteMinutes = c.durationSeconds / 60;
      return commuteMinutes <= criteria.maxCommuteMinutes ? [{ venue, commuteMinutes }] : [];
    })
    .sort((a, b) => a.commuteMinutes - b.commuteMinutes || a.venue.name.localeCompare(b.venue.name));
}
