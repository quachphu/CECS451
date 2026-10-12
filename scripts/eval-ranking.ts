/**
 * Ranking evaluation (Step 9d): NDCG@5 [P8] for the three required scenarios,
 * comparing distance-only, the v0 weighted formula (eval/baselines.ts) and the
 * expected-utility ranking (src/lib/ranking.ts), against graded 0–3 team
 * judgments in eval/ranking-judgments.csv (scenario,venue_name,relevance,judge;
 * several judges' grades for a venue are averaged).
 *
 *   npx tsx scripts/eval-ranking.ts --export   # once: dump each scenario's venues from Supabase
 *   npx tsx scripts/eval-ranking.ts            # offline: rank and score
 *
 * The export (eval/ranking-venues.json) is gitignored — it holds Places-derived
 * venue data. Commute uses the haversine estimate so results are deterministic
 * and need no routing key.
 */
import { config } from "dotenv";
config({ path: [".env.local", ".env"] });

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseCsv } from "../eval/csv";
import { distanceOnlyRank, v0RankVenues } from "../eval/baselines";
import { ndcgAtK } from "../eval/metrics";
import { boundingBox } from "@/lib/geo/bounding-box";
import { haversineEstimate, type CommuteMode, type LatLng } from "@/lib/geo/commute";
import { rankVenues, type SearchCriteria, type VenueWithRelations } from "@/lib/ranking";
import type { RoomStyle } from "@/lib/supabase/types";

type Scenario = { id: string; label: string; origin: LatLng; criteria: SearchCriteria & { style?: RoomStyle } };

// The three required scenarios (README), with the origins used by the seed and load-test scripts.
export const SCENARIOS: Scenario[] = [
  {
    id: "nyc",
    label: "50 people, Times Square, <20 min",
    origin: { lat: 40.758, lng: -73.9855 },
    criteria: { headcount: 50, maxCommuteMinutes: 20, commuteMode: "walk" },
  },
  {
    id: "sf",
    label: "30 people, Salesforce Tower, <15 min",
    origin: { lat: 37.7898, lng: -122.3969 },
    criteria: { headcount: 30, maxCommuteMinutes: 15, commuteMode: "walk" },
  },
  {
    id: "waikiki",
    label: "200 people, reception, Hilton Hawaiian Village, <15 min walk",
    origin: { lat: 21.2832, lng: -157.8357 },
    criteria: { headcount: 200, maxCommuteMinutes: 15, commuteMode: "walk", style: "reception" },
  },
];

const VENUES_PATH = join(process.cwd(), "eval", "ranking-venues.json");
const SPEED_MPS: Record<CommuteMode, number> = { walk: 1.34, drive: 8.9 };

async function exportVenues() {
  const { createServiceClient } = await import("@/lib/supabase/server");
  const supabase = createServiceClient();
  const out: Record<string, VenueWithRelations[]> = {};
  for (const s of SCENARIOS) {
    const radius = SPEED_MPS[s.criteria.commuteMode] * s.criteria.maxCommuteMinutes * 60 * 1.6;
    const box = boundingBox(s.origin, radius);
    const { data, error } = await supabase
      .from("venues")
      .select("*, rooms:venue_rooms(*), photos:venue_photos(*)")
      .gte("lat", box.minLat)
      .lte("lat", box.maxLat)
      .gte("lng", box.minLng)
      .lte("lng", box.maxLng);
    if (error) throw error;
    out[s.id] = (data ?? []) as unknown as VenueWithRelations[];
    console.log(`${s.id}: ${out[s.id].length} venues`);
  }
  writeFileSync(VENUES_PATH, JSON.stringify(out));
  console.log(`wrote ${VENUES_PATH}`);
}

function score() {
  const venuesByScenario = JSON.parse(readFileSync(VENUES_PATH, "utf8")) as Record<string, VenueWithRelations[]>;
  const judgments = parseCsv(readFileSync(join(process.cwd(), "eval", "ranking-judgments.csv"), "utf8"));
  const results: Record<string, unknown> = {};
  const means: Record<string, number[]> = { distance: [], v0: [], expectedUtility: [] };

  for (const s of SCENARIOS) {
    const venues = venuesByScenario[s.id] ?? [];
    const grades = new Map<string, number[]>();
    for (const j of judgments.filter((j) => j.scenario === s.id)) {
      grades.set(j.venue_name, [...(grades.get(j.venue_name) ?? []), Number(j.relevance)]);
    }
    const relevance = (name: string) => {
      const g = grades.get(name);
      return g ? g.reduce((a, b) => a + b, 0) / g.length : 0; // unjudged counts as not relevant
    };
    const allJudged = [...grades.keys()].map(relevance);
    const commutes = new Map(
      venues.map((v) => [v.id, haversineEstimate(s.origin, { lat: v.lat, lng: v.lng }, s.criteria.commuteMode)])
    );

    const rankings = {
      distance: distanceOnlyRank(s.criteria, venues, commutes).map((r) => r.venue.name),
      v0: v0RankVenues(s.criteria, venues, commutes).map((r) => r.venue.name),
      expectedUtility: rankVenues(s.criteria, venues, commutes).map((r) => r.venue.name),
    };
    const scenarioResult: Record<string, unknown> = {
      label: s.label,
      judgedVenues: grades.size,
      venues: venues.length,
    };
    for (const [name, order] of Object.entries(rankings)) {
      const ndcg = ndcgAtK(order.map(relevance), allJudged, 5);
      means[name].push(ndcg);
      scenarioResult[name] = { ndcgAt5: Math.round(ndcg * 1000) / 1000, top5: order.slice(0, 5) };
    }
    results[s.id] = scenarioResult;
  }
  results.meanNdcgAt5 = Object.fromEntries(
    Object.entries(means).map(([k, v]) => [
      k,
      v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 1000) / 1000 : null,
    ])
  );

  writeFileSync(join(process.cwd(), "eval", "ranking-results.json"), JSON.stringify(results, null, 2) + "\n");
  console.log(JSON.stringify(results, null, 2));
}

if (process.argv.includes("--export")) {
  exportVenues().catch((err) => {
    console.error(err);
    process.exit(1);
  });
} else {
  score();
}
