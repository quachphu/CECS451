import "server-only";

/**
 * Fetches the bytes of a Google Places photo, recovering from expired photo
 * names.
 *
 * A photo name (`places/{placeId}/photos/{token}`) is a short-lived token, not
 * a stable ID: Google returns a different token for the same photo on every
 * search, an old one fails with 400 "The photo resource in the request is
 * invalid. Please retrieve it from Places API endpoints.", and the Places
 * terms say the name can't be cached. The place ID inside it is stable (and
 * may be stored), so when the stored name has expired we ask Place Details for
 * a fresh one and fetch that instead.
 */

const PLACES_BASE = "https://places.googleapis.com/v1";
const MAX_WIDTH_PX = 1200;
const TIMEOUT_MS = 10_000;
/** Fresh names are reused briefly so a page of cards costs one lookup per venue, not one per view. */
const FRESH_NAME_TTL_MS = 30 * 60 * 1000;

export const PLACE_PHOTO_NAME_PATTERN = /^places\/([A-Za-z0-9_-]+)\/photos\/[A-Za-z0-9_-]+$/;

type FetchFn = typeof fetch;

const freshNames = new Map<string, { name: string; expiresAt: number }>();

/** Test hook: forget cached fresh names. */
export function clearPlacePhotoCache() {
  freshNames.clear();
}

async function fetchMedia(name: string, apiKey: string, fetchImpl: FetchFn): Promise<Response | null> {
  const url = new URL(`${PLACES_BASE}/${name}/media`);
  url.searchParams.set("maxWidthPx", String(MAX_WIDTH_PX));
  url.searchParams.set("key", apiKey);
  const res = await fetchImpl(url, { redirect: "follow", signal: AbortSignal.timeout(TIMEOUT_MS) }).catch(() => null);
  if (res?.ok && res.body) return res;
  if (res) console.warn(`[place-photo] media request failed: ${res.status}`);
  return null;
}

async function lookUpFreshName(placeId: string, apiKey: string, fetchImpl: FetchFn): Promise<string | null> {
  const cached = freshNames.get(placeId);
  if (cached && cached.expiresAt > Date.now()) return cached.name;

  const res = await fetchImpl(`${PLACES_BASE}/places/${placeId}`, {
    headers: { "X-Goog-Api-Key": apiKey, "X-Goog-FieldMask": "photos.name" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).catch(() => null);
  if (!res?.ok) {
    if (res) console.warn(`[place-photo] place details request failed: ${res.status}`);
    return null;
  }
  const body = (await res.json().catch(() => null)) as { photos?: Array<{ name?: string }> } | null;
  const name = body?.photos?.[0]?.name;
  if (!name || !PLACE_PHOTO_NAME_PATTERN.test(name)) return null;

  freshNames.set(placeId, { name, expiresAt: Date.now() + FRESH_NAME_TTL_MS });
  return name;
}

/**
 * The photo's bytes, or null when the place has no photo or Google can't be
 * reached. `name` must already match PLACE_PHOTO_NAME_PATTERN.
 */
export async function fetchPlacePhoto(
  name: string,
  apiKey: string,
  fetchImpl: FetchFn = fetch
): Promise<Response | null> {
  const placeId = PLACE_PHOTO_NAME_PATTERN.exec(name)?.[1];
  if (!placeId) return null;

  // A name refreshed recently is known-good; the stored one has probably expired.
  const cached = freshNames.get(placeId);
  if (cached && cached.expiresAt > Date.now()) {
    const res = await fetchMedia(cached.name, apiKey, fetchImpl);
    if (res) return res;
    freshNames.delete(placeId);
  } else {
    const res = await fetchMedia(name, apiKey, fetchImpl);
    if (res) return res;
  }

  const fresh = await lookUpFreshName(placeId, apiKey, fetchImpl);
  if (!fresh) return null;
  return fetchMedia(fresh, apiKey, fetchImpl);
}
