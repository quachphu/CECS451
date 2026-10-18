/**
 * Stratified sampling (city × bucket) for 01_sample_venues.ts.
 */
import {
  BUCKETS,
  type Bucket,
} from "../../../src/lib/discovery/category-buckets";
import { seededShuffle } from "./io";

export const CITY_CODES = {
  nyc: "NYC",
  sf: "SF",
  hnl: "Honolulu",
  la: "LA",
} as const;
export type CityCode = keyof typeof CITY_CODES;

/** Venues sampled per city: 560 in total (500 needed plus ~12% expected failures). */
export const CITY_TARGETS: Record<CityCode, number> = {
  nyc: 145,
  sf: 145,
  hnl: 100,
  la: 170,
};
export const MIN_PER_BUCKET = 8;
export const RESERVE_SHARE = 0.15;

/**
 * Bounding boxes (south, west, north, east). Honolulu and LA are several
 * neighbourhoods; a venue counts for the city if it falls in any of its boxes.
 */
export const CITY_BOXES: Record<
  CityCode,
  Array<{ name: string; s: number; w: number; n: number; e: number }>
> = {
  nyc: [
    { name: "Midtown Manhattan", s: 40.74, w: -74.005, n: 40.77, e: -73.965 },
  ],
  sf: [
    {
      name: "Financial District / SoMa",
      s: 37.77,
      w: -122.412,
      n: 37.799,
      e: -122.388,
    },
  ],
  hnl: [
    { name: "Waikiki", s: 21.27, w: -157.84, n: 21.29, e: -157.815 },
    { name: "Downtown Honolulu", s: 21.3, w: -157.868, n: 21.315, e: -157.854 },
  ],
  la: [
    { name: "Downtown LA", s: 34.035, w: -118.265, n: 34.06, e: -118.235 },
    { name: "West Hollywood", s: 34.08, w: -118.395, n: 34.1, e: -118.345 },
    { name: "Santa Monica", s: 34.005, w: -118.505, n: 34.035, e: -118.48 },
  ],
};

export function cityOf(lat: number, lng: number): CityCode | null {
  for (const [city, boxes] of Object.entries(CITY_BOXES) as Array<
    [CityCode, (typeof CITY_BOXES)[CityCode]]
  >) {
    if (boxes.some((b) => lat >= b.s && lat <= b.n && lng >= b.w && lng <= b.e))
      return city;
  }
  return null;
}

/**
 * Splits a city's target across buckets in proportion to what's available,
 * with at least min(MIN_PER_BUCKET, available) per bucket, never more than
 * available, summing to the target where the city has enough venues
 * (largest-remainder rounding; leftovers go to buckets with spare venues).
 */
export function allocate(
  available: Record<Bucket, number>,
  target: number,
  minPerBucket = MIN_PER_BUCKET,
): Record<Bucket, number> {
  const out = Object.fromEntries(BUCKETS.map((b) => [b, 0])) as Record<
    Bucket,
    number
  >;
  const total = BUCKETS.reduce((s, b) => s + available[b], 0);
  if (total <= target) {
    for (const b of BUCKETS) out[b] = available[b];
    return out;
  }
  for (const b of BUCKETS) out[b] = Math.min(minPerBucket, available[b]);
  let remaining = target - BUCKETS.reduce((s, b) => s + out[b], 0);
  if (remaining < 0) {
    // Minimums alone exceed the target: shrink the largest allocations first.
    while (remaining < 0) {
      const b = [...BUCKETS].sort((x, y) => out[y] - out[x])[0];
      out[b]--;
      remaining++;
    }
    return out;
  }
  // Distribute the rest proportionally to spare capacity.
  const spare = (b: Bucket) => available[b] - out[b];
  while (remaining > 0) {
    const spareTotal = BUCKETS.reduce((s, b) => s + spare(b), 0);
    if (spareTotal === 0) break;
    const shares = BUCKETS.map((b) => ({
      b,
      exact: (remaining * spare(b)) / spareTotal,
    }));
    let given = 0;
    for (const s of shares) {
      const n = Math.min(Math.floor(s.exact), spare(s.b));
      out[s.b] += n;
      given += n;
    }
    remaining -= given;
    if (remaining > 0) {
      const order = shares
        .filter((s) => spare(s.b) > 0)
        .sort(
          (a, b) =>
            b.exact - Math.floor(b.exact) - (a.exact - Math.floor(a.exact)) ||
            BUCKETS.indexOf(a.b) - BUCKETS.indexOf(b.b),
        );
      for (const s of order) {
        if (remaining === 0) break;
        out[s.b]++;
        remaining--;
      }
    }
  }
  return out;
}

export type Candidate = { key: string; bucket: Bucket };

/** Draws the sample and the reserve (15% extra per stratum) with the seeded PRNG. */
export function drawStratum<T extends Candidate>(
  candidates: readonly T[],
  n: number,
  rand: () => number,
): { sample: T[]; reserve: T[] } {
  const ordered = seededShuffle(
    [...candidates].sort((a, b) => a.key.localeCompare(b.key)),
    rand,
  );
  const sample = ordered.slice(0, n);
  const reserveN = Math.ceil(n * RESERVE_SHARE);
  return { sample, reserve: ordered.slice(n, n + reserveN) };
}

/** venue_id: city code plus a 4-digit sequence, e.g. "nyc-0001". */
export function venueId(city: CityCode, index: number): string {
  return `${city}-${String(index).padStart(4, "0")}`;
}
