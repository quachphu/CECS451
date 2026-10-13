import { createServiceClient } from "@/lib/supabase/server";
import { orderByPrior } from "@/lib/discovery/discovery-prior";
import { discoverNearbyVenues, type CandidateVenue } from "@/lib/discovery/places";
import { extractPrivateDiningWithLlm, isLlmExtractionConfigured, type LlmExtraction } from "@/lib/discovery/llm-extract";
import { renderPage, type RenderedPage } from "@/lib/discovery/render";
import { createRobotsChecker, type RobotsChecker } from "@/lib/discovery/robots";
import { featureLog } from "@/lib/discovery/confidence";
import { applyRenderedPage, scrapeVenueForPrivateDining, type ScrapedSignals } from "@/lib/discovery/scraper";
import { buildVenueDraft, type VenueDraft } from "@/lib/discovery/trust";
import { haversineMeters, type LatLng } from "@/lib/geo/commute";
import { boundingBox } from "@/lib/geo/bounding-box";
import { createLimiter } from "@/lib/limiter";

/**
 * A dense downtown core (Times Square, the Financial District) returns far
 * more candidates than a quiet neighbourhood, and the venues that actually
 * host 200-person receptions are frequently not in the first 12 results —
 * discovery order reflects proximity and place type, not private-dining
 * capability. 12 was leaving real venues undiscovered there, so the cap
 * scales with how crowded the area turned out to be.
 *
 * Measured against Times Square (scripts/loadtest-density.ts): a 20-minute
 * driving radius returns ~70 candidates, so a cap of 30 was reading well under
 * half the area and finding only 7 venues with a site-confirmed capacity. The
 * ceilings below cover essentially all of them. Raising them costs nothing in
 * API spend — this tier is a plain HTTP GET plus an HTML parse, and the paid
 * tiers stay bounded by MAX_RENDER_BUDGET and MAX_LLM_BUDGET regardless.
 */
function candidateCap(candidateCount: number): number {
  if (candidateCount >= 60) return 45;
  if (candidateCount >= 30) return 25;
  return 15;
}

/**
 * Raised alongside the caps above so wall-clock time for a first search in a
 * dense area stays roughly flat instead of scaling with the new ceiling.
 *
 * Safe to raise because these requests fan out across distinct venue domains —
 * 8 in flight is still about one connection per host, not 8 against any single
 * restaurant's server.
 */
const SCRAPE_CONCURRENCY = 8;

/**
 * Caps LLM extraction calls per run. The LLM now reads every candidate with a
 * private-dining page — not only those where the regex found nothing — because
 * a second, independent read is what can upgrade a regex figure to `verified`
 * (or expose a disagreement). Budget is claimed in candidate order — highest
 * discovery prior first (see discovery-prior.ts) — so it goes to the likeliest
 * venues.
 */
export const MAX_LLM_BUDGET = 12;

/**
 * LLM calls run on their own queue, not inside a scrape worker. Each call can
 * take tens of seconds (45 s timeout); inline, it held one of the 8 scrape
 * slots for that whole time and stalled every scrape queued behind it.
 */
const LLM_CONCURRENCY = 8;

/**
 * Caps Firecrawl renders per run (1 credit per page, per the Firecrawl v2
 * scrape docs [D1]). Rendering used to be called from inside the scraper for
 * every candidate without a static capacity figure, outside any budget, so a
 * dense-area run could render all 45 candidates. Shared across the run's
 * concurrent workers; claimed before the request is sent.
 */
export const MAX_RENDER_BUDGET = 10;

function citySlugForOrigin(): string {
  // Auto-discovered venues aren't tied to one of the 3 demo city buckets —
  // they're grouped by discovery run instead, distance filtering happens
  // by lat/lng at query time regardless of this label.
  return "auto";
}

function normalizeVenueName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[’'".,()]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// A curated seed venue and Google's own index have no shared identifier, so
// Google discovering a restaurant that's already in the curated set (a real,
// common case — Kokkari and Wayfare Tavern both surfaced this way) looks
// identical to genuinely finding a new venue. Left unguarded, that produces
// two cards for the same physical restaurant in results, which is worse than
// missing a photo. Same normalized name within a tight radius is treated as
// the same venue; the radius is small enough that it won't falsely merge two
// unrelated places that happen to share a common name on the same block.
const DEDUP_RADIUS_METERS = 75;

async function findExistingVenueMatch(draft: VenueDraft): Promise<{ id: string; hasPhoto: boolean } | null> {
  const supabase = createServiceClient();
  const box = boundingBox({ lat: draft.lat, lng: draft.lng }, DEDUP_RADIUS_METERS);

  const { data } = await supabase
    .from("venues")
    .select("id, name, lat, lng, place_source_id, photos:venue_photos(id)")
    .gte("lat", box.minLat)
    .lte("lat", box.maxLat)
    .gte("lng", box.minLng)
    .lte("lng", box.maxLng);

  const targetName = normalizeVenueName(draft.name);
  for (const row of data ?? []) {
    // A re-scrape of a venue this exact call already discovered before isn't
    // a duplicate, it's an update — let the normal upsert-by-place_source_id
    // path below handle it.
    if (row.place_source_id === draft.placeSourceId) continue;
    if (normalizeVenueName(row.name) !== targetName) continue;
    if (haversineMeters({ lat: draft.lat, lng: draft.lng }, { lat: row.lat, lng: row.lng }) > DEDUP_RADIUS_METERS) continue;
    return { id: row.id, hasPhoto: row.photos.length > 0 };
  }
  return null;
}

async function upsertVenueDraft(draft: VenueDraft) {
  const supabase = createServiceClient();

  const existingMatch = await findExistingVenueMatch(draft);
  if (existingMatch) {
    // Don't create a second card for a venue already in the catalog — but a
    // free real photo for one that's missing one is still worth keeping.
    if (!existingMatch.hasPhoto && draft.imageUrl) {
      await supabase.from("venue_photos").insert({
        venue_id: existingMatch.id,
        url: draft.imageUrl,
        alt_text: draft.name,
        sort_order: 0,
        is_primary: true,
      });
    }
    return;
  }

  const { data: venue, error: venueError } = await supabase
    .from("venues")
    .upsert(
      {
        source: "auto_discovered",
        place_source_id: draft.placeSourceId,
        name: draft.name,
        formatted_address: draft.formattedAddress,
        lat: draft.lat,
        lng: draft.lng,
        city_slug: citySlugForOrigin(),
        category: draft.category,
        price_tier: draft.priceTier,
        price_tier_trust: draft.priceTierTrust,
        min_spend_usd: draft.minSpendUsd,
        min_spend_trust: draft.minSpendTrust,
        phone: draft.phone,
        email: draft.email,
        website: draft.website,
        description: draft.description,
        source_note: draft.sourceNote,
        menu_url: draft.menuUrl,
        menu_trust: draft.menuTrust,
        dietary_notes: draft.dietaryNotes,
        dietary_trust: draft.dietaryTrust,
        last_checked_at: new Date().toISOString(),
      },
      { onConflict: "place_source_id" }
    )
    .select("id")
    .single();

  if (venueError || !venue) {
    console.error("Failed to upsert discovered venue", draft.name, venueError);
    return;
  }

  // Rooms are fully replaced on every re-scrape so stale capacity figures
  // don't linger after a venue updates its site.
  await supabase.from("venue_rooms").delete().eq("venue_id", venue.id);
  if (draft.rooms.length > 0) {
    const { error: roomsError } = await supabase.from("venue_rooms").insert(
      draft.rooms.map((room) => ({
        venue_id: venue.id,
        room_name: room.roomName,
        min_capacity: room.minCapacity ?? null,
        max_capacity: room.maxCapacity,
        style: room.style,
        capacity_trust: room.capacityTrust,
        notes: room.notes ?? null,
        is_estimate: room.isEstimate,
        evidence_quote: room.evidenceQuote,
        evidence_url: room.evidenceUrl,
        capacity_confidence: room.confidence,
        confidence_features: featureLog(room.confidenceFeatures),
      }))
    );
    // A venue with no rooms never appears in search, so this must not fail
    // silently. The usual cause is a database missing migration 0011.
    if (roomsError) {
      console.error(
        `Failed to write rooms for ${draft.name} — is supabase/migrations/0011_ai_core.sql applied?`,
        roomsError
      );
    }
  }

  // Photos are replaced on every re-scrape too, same as rooms — a venue that
  // gains a real photo on a later scrape (or loses one) should reflect that
  // rather than keeping a stale one.
  //
  // No placeholder fallback: this previously inserted a random stock photo so
  // cards were never empty, which meant a planner evaluating a venue was
  // looking at a picture of somewhere else entirely. The card has an explicit
  // "no photo found" state, and that's strictly more useful than a confident
  // wrong image. Only genuine Google Places photos of this exact location are
  // stored.
  await supabase.from("venue_photos").delete().eq("venue_id", venue.id);
  if (draft.imageUrl) {
    await supabase.from("venue_photos").insert({
      venue_id: venue.id,
      url: draft.imageUrl,
      alt_text: draft.name,
      sort_order: 0,
      is_primary: true,
    });
  }
}

/** The I/O the enrichment stage depends on, injectable so tests can stub it. */
export type EnrichmentDeps = {
  scrape: (website: string, robots?: RobotsChecker) => Promise<ScrapedSignals>;
  render: (url: string) => Promise<RenderedPage | null>;
  extract: (venueName: string, pageText: string, privateDiningText: string) => Promise<LlmExtraction | null>;
  isLlmConfigured: () => boolean;
};

const defaultDeps: EnrichmentDeps = {
  scrape: (website, robots) => scrapeVenueForPrivateDining(website, { robots }),
  render: renderPage,
  extract: extractPrivateDiningWithLlm,
  isLlmConfigured: isLlmExtractionConfigured,
};

export type EnrichmentStats = {
  renders: number;
  llmCalls: number;
  /** Hosts with at least one page skipped because robots.txt disallowed it. */
  robotsSkippedHosts: number;
  /** Venues drafted without reading their site because the homepage was disallowed. */
  robotsBlockedVenues: number;
  /** Venues whose site (robots.txt) couldn't be reached at all, so nothing was read. */
  unreachableVenues: number;
};

function needsLlmRead(signals: ScrapedSignals | null, deps: EnrichmentDeps): signals is ScrapedSignals {
  return signals != null && signals.privateDiningPageFound && signals.combinedText.length > 0 && deps.isLlmConfigured();
}

/**
 * Scrapes each candidate, renders where the static pass found no capacity and
 * the run's render budget allows, runs the LLM tier where warranted, and
 * derives trust labels. Pure apart from the injected I/O — nothing here
 * touches the database.
 *
 * Two queues, pipelined: scrapes (and their renders) run 8 at a time; each
 * finished scrape that warrants an LLM read is handed to a separate 8-wide LLM
 * queue that starts immediately, so a slow model call never holds a scrape
 * slot. Drafts are built once both queues drain.
 */
export async function enrichCandidates(
  candidates: CandidateVenue[],
  deps: EnrichmentDeps = defaultDeps
): Promise<{ drafts: VenueDraft[]; stats: EnrichmentStats }> {
  const stats: EnrichmentStats = {
    renders: 0,
    llmCalls: 0,
    robotsSkippedHosts: 0,
    robotsBlockedVenues: 0,
    unreachableVenues: 0,
  };
  // One robots.txt fetch per host per run.
  const robots = createRobotsChecker();
  const scrapeLimit = createLimiter(SCRAPE_CONCURRENCY);
  const llmLimit = createLimiter(LLM_CONCURRENCY);
  const llmReads: Array<Promise<LlmExtraction | null>> = candidates.map(() => Promise.resolve(null));

  const signalsList = await Promise.all(
    candidates.map((candidate, index) =>
      scrapeLimit(async () => {
        let signals = candidate.website ? await deps.scrape(candidate.website, robots) : null;
        if (signals?.robotsBlocked) stats.robotsBlockedVenues += 1;
        if (signals?.siteUnreachable) stats.unreachableVenues += 1;

        // Budgets are claimed synchronously, before any await, so concurrent
        // workers can never overshoot them.
        if (signals?.renderTarget && stats.renders < MAX_RENDER_BUDGET) {
          stats.renders += 1;
          const rendered = await deps.render(signals.renderTarget);
          if (rendered?.text) signals = applyRenderedPage(signals, rendered, candidate.website!);
        }

        if (needsLlmRead(signals, deps) && stats.llmCalls < MAX_LLM_BUDGET) {
          stats.llmCalls += 1;
          const read = signals;
          // Not awaited here — the scrape slot is released immediately.
          llmReads[index] = llmLimit(() => deps.extract(candidate.name, read.combinedText, read.privateDiningText ?? "")).catch(
            () => null
          );
        }

        return signals;
      })
    )
  );

  const llmResults = await Promise.all(llmReads);
  stats.robotsSkippedHosts = robots.skippedHosts.size;
  const drafts = candidates.map((candidate, index) => buildVenueDraft(candidate, signalsList[index], llmResults[index]));

  return { drafts, stats };
}

/**
 * Runs live discovery for an area: find candidate venues, scrape each for
 * private-dining signals, derive trust labels, and upsert everything into
 * Supabase. Called by the search flow when there isn't fresh cached
 * coverage for the area already (see src/lib/discovery/ensure-coverage.ts).
 */
export async function runDiscoveryPipeline(
  origin: LatLng,
  radiusMeters: number
): Promise<{ discovered: number; robotsSkippedHosts: number; robotsBlockedVenues: number; unreachableVenues: number }> {
  const candidates = await discoverNearbyVenues(origin, radiusMeters);
  // Likeliest private-event hosts first, so the cap and the render/LLM
  // budgets (claimed in this order) go to them rather than to whatever is
  // nearest.
  const toScrape = orderByPrior(candidates).slice(0, candidateCap(candidates.length));

  const { drafts, stats } = await enrichCandidates(toScrape);

  await Promise.all(drafts.map(upsertVenueDraft));

  return {
    discovered: drafts.length,
    robotsSkippedHosts: stats.robotsSkippedHosts,
    robotsBlockedVenues: stats.robotsBlockedVenues,
    unreachableVenues: stats.unreachableVenues,
  };
}
