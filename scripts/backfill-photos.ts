/**
 * Gives every venue that has no photo a real Google Places photo of that same
 * place, when Google has a confident match (see src/lib/discovery/photo-lookup.ts).
 * Venues Google can't match keep their "No photo found" state.
 *
 * Usage: npm run photos:backfill
 * Also runs at the end of `npm run seed`. Safe to re-run: it only touches
 * venues with no photo.
 */
import { config } from "dotenv";
config({ path: [".env.local", ".env"] });
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { lookUpVenuePhoto } from "../src/lib/discovery/photo-lookup";

export async function backfillVenuePhotos(supabase: SupabaseClient, apiKey: string) {
  const { data, error } = await supabase
    .from("venues")
    .select("id, name, formatted_address, lat, lng, photos:venue_photos(id)");
  if (error) throw new Error(`Could not read venues: ${error.message}`);

  const missing = (data ?? []).filter((v) => v.photos.length === 0);
  console.log(`${missing.length} of ${data?.length ?? 0} venues have no photo.`);

  let added = 0;
  for (const venue of missing) {
    const url = await lookUpVenuePhoto(
      { name: venue.name, formattedAddress: venue.formatted_address, lat: venue.lat, lng: venue.lng },
      apiKey
    );
    if (!url) {
      console.log(`  ${venue.name}: no confident Google match — left without a photo`);
      continue;
    }
    const { error: insertError } = await supabase
      .from("venue_photos")
      .insert({ venue_id: venue.id, url, alt_text: venue.name, sort_order: 0, is_primary: true });
    if (insertError) {
      console.warn(`  ${venue.name}: failed to save photo (${insertError.message})`);
      continue;
    }
    added += 1;
    console.log(`  ${venue.name}: photo added`);
  }
  console.log(`Added ${added} photo${added === 1 ? "" : "s"}.`);
}

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!url || !serviceKey) throw new Error("Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local.");
  if (!apiKey) throw new Error("Set GOOGLE_PLACES_API_KEY in .env.local — photos come from Google Places.");
  await backfillVenuePhotos(createClient(url, serviceKey), apiKey);
}

if (process.argv[1]?.endsWith("backfill-photos.ts")) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
