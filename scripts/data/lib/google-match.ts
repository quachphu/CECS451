/**
 * Accepting a Google Text Search result as the same venue (Step 2).
 */
import { registeredDomain } from "../../../src/lib/discovery/web-links";
import { haversineMeters } from "../../../src/lib/geo/commute";

export const MAX_MATCH_METERS = 150;
export const MIN_NAME_SIMILARITY = 0.6;

const NAME_STOPWORDS = new Set(["the", "and", "of", "at", "a"]);

export function nameTokens(name: string): Set<string> {
  return new Set(
    name
      .toLowerCase()
      .normalize("NFD")
      .replace(/\p{M}/gu, "")
      .replace(/&/g, " and ")
      .split(/[^a-z0-9]+/)
      .filter((t) => t && !NAME_STOPWORDS.has(t)),
  );
}

/** Token Jaccard similarity of two venue names. */
export function nameSimilarity(a: string, b: string): number {
  const ta = nameTokens(a);
  const tb = nameTokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}

export type MatchDecision = {
  accepted: boolean;
  distanceM: number | null;
  nameSimilarity: number;
  domainMatch: boolean;
};

/**
 * Accept the top result only if it is within 150 m AND either the names are
 * similar (Jaccard ≥ 0.6) or both list the same website domain. Anything else
 * is "no match"; the script never guesses.
 */
export function decideMatch(
  venue: { name: string; lat: number; lng: number; website: string | null },
  place: {
    name: string;
    lat: number | null;
    lng: number | null;
    websiteUri: string | null;
  },
): MatchDecision {
  const distanceM =
    place.lat == null || place.lng == null
      ? null
      : haversineMeters(
          { lat: venue.lat, lng: venue.lng },
          { lat: place.lat, lng: place.lng },
        );
  const similarity = nameSimilarity(venue.name, place.name);
  const a = registeredDomain(venue.website);
  const domainMatch = a != null && a === registeredDomain(place.websiteUri);
  const accepted =
    distanceM != null &&
    distanceM <= MAX_MATCH_METERS &&
    (similarity >= MIN_NAME_SIMILARITY || domainMatch);
  return { accepted, distanceM, nameSimilarity: similarity, domainMatch };
}

export const PRICE_LEVEL_TO_NUMBER: Record<string, number> = {
  PRICE_LEVEL_FREE: 0,
  PRICE_LEVEL_INEXPENSIVE: 1,
  PRICE_LEVEL_MODERATE: 2,
  PRICE_LEVEL_EXPENSIVE: 3,
  PRICE_LEVEL_VERY_EXPENSIVE: 4,
};
