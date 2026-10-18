/**
 * Step 2: add the Google Places fields the app's discovery prior sees at
 * runtime (types, price level, rating, review count) [D3].
 *
 *   npx tsx scripts/data/02_enrich_google.ts            # venues.csv (+ any replacements)
 *   npx tsx scripts/data/02_enrich_google.ts --limit 3  # first N only
 *
 * One Text Search (New) call per venue, biased to the venue's coordinates;
 * the top result is accepted only within 150 m and with a similar name or the
 * same website domain (lib/google-match.ts). Writes eval/google_features.csv,
 * which is gitignored: Google content other than place IDs must be deleted or
 * refreshed within 30 days [D3b] (the date is recorded in DATA_CARD.md).
 *
 * Resumable: venues already in the file are skipped. Calls are capped by
 * GOOGLE_TEXT_SEARCH_CAP (default 900) in eval/.spend/google_text_search.json,
 * to stay inside the free monthly cap (see NOTES-training.md).
 */
import { existsSync } from "node:fs";
import { Budget, BudgetExceededError } from "./lib/budget";
import { requireEnv } from "./lib/env";
import { decideMatch, PRICE_LEVEL_TO_NUMBER } from "./lib/google-match";
import { cliArgs, evalDir, readCsv, sleep, writeCsvAtomic } from "./lib/io";
import { RunManifest } from "./lib/manifest";

export const GOOGLE_COLUMNS = [
  "venue_id",
  "google_place_id",
  "fetched_at",
  "display_name",
  "primary_type",
  "types",
  "price_level",
  "rating",
  "user_rating_count",
  "website_uri",
  "lat",
  "lng",
  "distance_m",
  "name_similarity",
  "domain_match",
  "google_match",
] as const;

const ENDPOINT = "https://places.googleapis.com/v1/places:searchText";
const FIELD_MASK = [
  "places.id",
  "places.displayName",
  "places.types",
  "places.primaryType",
  "places.priceLevel",
  "places.rating",
  "places.userRatingCount",
  "places.websiteUri",
  "places.location",
].join(",");
const BIAS_RADIUS_M = 200;
const MAX_TRIES = 5;

type Place = {
  id?: string;
  displayName?: { text?: string };
  types?: string[];
  primaryType?: string;
  priceLevel?: string;
  rating?: number;
  userRatingCount?: number;
  websiteUri?: string;
  location?: { latitude?: number; longitude?: number };
};

async function textSearch(
  apiKey: string,
  query: string,
  lat: number,
  lng: number,
  budget: Budget
): Promise<Place | null> {
  for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
    budget.reserve(1);
    const res = await fetch(ENDPOINT, {
      method: "POST",
      signal: AbortSignal.timeout(15_000),
      headers: { "Content-Type": "application/json", "X-Goog-Api-Key": apiKey, "X-Goog-FieldMask": FIELD_MASK },
      body: JSON.stringify({
        textQuery: query,
        pageSize: 1,
        locationBias: { circle: { center: { latitude: lat, longitude: lng }, radius: BIAS_RADIUS_M } },
      }),
    });
    budget.charge(1);
    if (res.status === 429 || res.status >= 500) {
      if (attempt === MAX_TRIES) throw new Error(`Google Text Search kept failing (${res.status}) for "${query}"`);
      await sleep(1000 * 2 ** (attempt - 1));
      continue;
    }
    if (!res.ok) throw new Error(`Google Text Search ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const body = (await res.json()) as { places?: Place[] };
    return body.places?.[0] ?? null;
  }
  return null;
}

async function main() {
  const { GOOGLE_PLACES_API_KEY: apiKey } = requireEnv("GOOGLE_PLACES_API_KEY");
  const { values } = cliArgs();
  const limit = values.has("limit") ? Number(values.get("limit")) : Infinity;
  const manifest = new RunManifest("02_enrich_google");
  manifest.models.google_endpoint = "places:searchText (New)";

  const venuesFile = evalDir("venues.csv");
  if (!existsSync(venuesFile)) throw new Error(`${venuesFile} not found; run 01_sample_venues.ts first.`);
  const reserveUsed = new Set(readCsv(evalDir("replacements.csv")).map((r) => r.replacement_venue_id));
  const venues = [
    ...readCsv(venuesFile),
    ...readCsv(evalDir("venues_reserve.csv")).filter((r) => reserveUsed.has(r.venue_id)),
  ];
  const outFile = evalDir("google_features.csv");
  const rows = readCsv(outFile);
  const done = new Set(rows.map((r) => r.venue_id));
  const budget = new Budget("google_text_search", "calls", Number(process.env.GOOGLE_TEXT_SEARCH_CAP ?? 900));
  manifest.inputs.push(venuesFile);

  let processed = 0;
  let status: "ok" | "aborted_budget" = "ok";
  try {
    for (const v of venues) {
      if (done.has(v.venue_id)) continue;
      if (processed >= limit) break;
      const lat = Number(v.lat);
      const lng = Number(v.lng);
      const place = await textSearch(apiKey, `${v.name}, ${v.address}`, lat, lng, budget);
      const decision = place
        ? decideMatch(
            { name: v.name, lat, lng, website: v.website },
            {
              name: place.displayName?.text ?? "",
              lat: place.location?.latitude ?? null,
              lng: place.location?.longitude ?? null,
              websiteUri: place.websiteUri ?? null,
            }
          )
        : null;
      const matched = Boolean(place && decision?.accepted);
      rows.push({
        venue_id: v.venue_id,
        google_place_id: matched ? place!.id : "",
        fetched_at: new Date().toISOString(),
        display_name: matched ? place!.displayName?.text : "",
        primary_type: matched ? place!.primaryType : "",
        types: matched ? (place!.types ?? []).join("|") : "",
        price_level: matched && place!.priceLevel ? PRICE_LEVEL_TO_NUMBER[place!.priceLevel] : "",
        rating: matched ? place!.rating : "",
        user_rating_count: matched ? place!.userRatingCount : "",
        website_uri: matched ? place!.websiteUri : "",
        lat: matched ? place!.location?.latitude : "",
        lng: matched ? place!.location?.longitude : "",
        distance_m: decision?.distanceM != null ? Math.round(decision.distanceM) : "",
        name_similarity: decision ? decision.nameSimilarity.toFixed(3) : "",
        domain_match: decision ? Number(decision.domainMatch) : "",
        google_match: matched ? "matched" : "none",
      } as Record<string, string>);
      manifest.count(matched ? "matched" : place ? "rejected_top_result" : "no_result");
      processed++;
      if (processed % 25 === 0) writeCsvAtomic(outFile, GOOGLE_COLUMNS, rows);
    }
  } catch (err) {
    if (!(err instanceof BudgetExceededError)) throw err;
    status = "aborted_budget";
    console.error(err.message);
  } finally {
    writeCsvAtomic(outFile, GOOGLE_COLUMNS, rows);
    manifest.spend.google_text_search_calls = budget.spent;
    manifest.outputs.push(outFile);
    manifest.write(status);
  }
  console.log(`Enriched ${processed} venues; ${rows.length} in ${outFile}. ${JSON.stringify(manifest.counts)}`);
  console.log(`Google Text Search calls so far: ${budget.spent} of cap ${budget.cap}.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
