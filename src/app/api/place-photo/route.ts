import { NextRequest, NextResponse } from "next/server";
import { fetchPlacePhoto, PLACE_PHOTO_NAME_PATTERN } from "@/lib/place-photo";

/**
 * Proxies Google Places photo bytes.
 *
 * Places API (New) serves photo media from an authenticated URL, so the naive
 * approach is to store `.../media?key=API_KEY` directly on the venue row —
 * which leaks the key into the database and into page HTML. Instead we store
 * only the photo resource name and attach the key here, server-side. The
 * stored name expires; fetchPlacePhoto swaps in a fresh one when it has.
 *
 * Responses are cached for a day by the browser.
 */

export async function GET(request: NextRequest) {
  const name = request.nextUrl.searchParams.get("name");
  if (!name) return NextResponse.json({ error: "Missing photo name" }, { status: 400 });
  // Validated so this can't be used as an open proxy to arbitrary Google endpoints.
  if (!PLACE_PHOTO_NAME_PATTERN.test(name)) return NextResponse.json({ error: "Invalid photo name" }, { status: 400 });

  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) {
    console.warn("[place-photo] GOOGLE_PLACES_API_KEY is not set; venue photos can't load");
    return NextResponse.json({ error: "Photo unavailable" }, { status: 404 });
  }

  const upstream = await fetchPlacePhoto(name, apiKey);
  if (!upstream?.body) return NextResponse.json({ error: "Photo unavailable" }, { status: 404 });

  return new NextResponse(upstream.body, {
    headers: {
      "Content-Type": upstream.headers.get("content-type") ?? "image/jpeg",
      "Cache-Control": "public, max-age=86400, stale-while-revalidate=604800",
    },
  });
}
