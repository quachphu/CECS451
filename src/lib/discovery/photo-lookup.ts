import { haversineMeters, type LatLng } from "@/lib/geo/commute";

/**
 * Finds a real Google Places photo for a venue we already know about (a
 * curated seed venue, or a discovered one that came without a photo).
 *
 * Only a photo of the same place is acceptable — a stock or wrong-branch photo
 * is a false claim about the room the planner is evaluating (see
 * src/lib/photos.ts) — so the Text Search hit must sit within MAX_MATCH_METERS
 * of the venue and share its name; otherwise the venue keeps its "No photo
 * found" state. The radius allows for resorts, whose map pin can sit a couple
 * of hundred metres from the street address.
 */

const SEARCH_ENDPOINT = "https://places.googleapis.com/v1/places:searchText";
const FIELD_MASK = "places.id,places.displayName,places.location,places.photos";
const MAX_MATCH_METERS = 300;
const TIMEOUT_MS = 10_000;

export type PhotoLookupVenue = { name: string; formattedAddress: string } & LatLng;

type TextSearchPlace = {
  displayName?: { text?: string };
  location?: { latitude?: number; longitude?: number };
  photos?: Array<{ name?: string }>;
};

/** Words that identify a venue; drops filler like "the", "restaurant", "& bar". */
function nameTokens(name: string): Set<string> {
  const filler = new Set(["the", "and", "restaurant", "bar", "grill", "hotel", "at", "of", "sf", "nyc"]);
  return new Set(
    name
      .toLowerCase()
      .normalize("NFD")
      .replace(/\p{M}/gu, "")
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 1 && !filler.has(t))
  );
}

function tokensContained(a: Set<string>, b: Set<string>): boolean {
  if (a.size === 0 || b.size === 0) return false;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  return [...small].every((t) => large.has(t));
}

/**
 * The ways a curated name may appear on Google: the whole name, the venue
 * before a "—" room qualifier ("Sheraton Waikiki — Hawaii Ballroom"), and the
 * name without a parenthetical ("Tropics Bar & Grill (Hilton Hawaiian Village)").
 */
function nameVariants(name: string): string[] {
  const variants = [name, name.split(/\s+[—–-]\s+/)[0], name.replace(/\([^)]*\)/g, " ")];
  return [...new Set(variants.map((v) => v.trim()).filter(Boolean))];
}

/** True when one name's identifying words are all in the other ("Perbacco" vs "Perbacco Ristorante + Bar"). */
export function namesMatch(venueName: string, googleName: string): boolean {
  const google = nameTokens(googleName);
  return nameVariants(venueName).some((v) => tokensContained(nameTokens(v), google));
}

export function placePhotoProxyUrl(photoName: string): string {
  return `/api/place-photo?name=${encodeURIComponent(photoName)}`;
}

/** The app's proxy URL for a photo of this venue, or null when Google has no confident match. */
export async function lookUpVenuePhoto(
  venue: PhotoLookupVenue,
  apiKey: string,
  fetchImpl: typeof fetch = fetch
): Promise<string | null> {
  const res = await fetchImpl(SEARCH_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Goog-Api-Key": apiKey, "X-Goog-FieldMask": FIELD_MASK },
    body: JSON.stringify({
      textQuery: `${venue.name}, ${venue.formattedAddress}`,
      maxResultCount: 3,
      locationBias: { circle: { center: { latitude: venue.lat, longitude: venue.lng }, radius: 500 } },
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).catch(() => null);
  if (!res?.ok) {
    if (res) console.warn(`[photo-lookup] text search failed for ${venue.name}: ${res.status}`);
    return null;
  }

  const body = (await res.json().catch(() => null)) as { places?: TextSearchPlace[] } | null;
  for (const place of body?.places ?? []) {
    const lat = place.location?.latitude;
    const lng = place.location?.longitude;
    const photoName = place.photos?.[0]?.name;
    if (lat == null || lng == null || !photoName) continue;
    if (haversineMeters(venue, { lat, lng }) > MAX_MATCH_METERS) continue;
    if (!namesMatch(venue.name, place.displayName?.text ?? "")) continue;
    return placePhotoProxyUrl(photoName);
  }
  return null;
}
