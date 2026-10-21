/**
 * Re-score saved rooms with the shipped confidence model.
 *
 *   npx tsx scripts/data/10_backfill_confidence.ts
 *
 * Uses saved snapshots and the student cache only. No Firecrawl, Grok, or
 * Google call. When Supabase is configured, curated seed rooms with a
 * researched number are stored as planner-confirmed, and an auto-discovered
 * room whose site we saved is updated in place.
 */
import { config } from "dotenv";
config({ path: [".env.local", ".env"] });

import { existsSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { featureLog, PLANNER_CONFIDENCE, trustFromConfidence } from "../../src/lib/discovery/confidence";
import type { LlmExtractedRoom, LlmExtraction } from "../../src/lib/discovery/llm-extract";
import type { CandidateVenue } from "../../src/lib/discovery/places";
import { signalsFromPages } from "../../src/lib/discovery/scraper";
import { buildVenueDraft, scorePageCapacity } from "../../src/lib/discovery/trust";
import { seedVenues } from "../../src/data/seed-venues";
import { evalDir, readCsv, readJson, readJsonl, writeJsonAtomic } from "./lib/io";
import { loadSnapshot, readVenueIndex } from "./lib/venue-index";
import { studentPages } from "./lib/student-input";

type CacheRoom = {
  room_name: string;
  capacity: number;
  min_capacity: number | null;
  evidence_quote: string | null;
  reads?: Array<number | null>;
  features?: { grounded?: boolean; self_consistency?: number | null };
  extraction_failed?: boolean;
};

type CacheFile = {
  venue?: { hosts_private_events?: boolean };
  rooms?: CacheRoom[];
};

const hostOf = (website: string | null | undefined): string | null => {
  if (!website) return null;
  try {
    return new URL(website.startsWith("http") ? website : `https://${website}`).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
};

function llmFromCache(cache: CacheFile | null): LlmExtraction | null {
  const rooms = (cache?.rooms ?? []).filter((room) => room.features?.grounded && !room.extraction_failed && room.capacity > 0);
  if (rooms.length === 0) return null;
  return {
    rooms: rooms.map(
      (room): LlmExtractedRoom => ({
        roomName: room.room_name,
        maxCapacity: room.capacity,
        minCapacity: room.min_capacity,
        evidenceQuote: room.evidence_quote ?? undefined,
        selfConsistency: room.features?.self_consistency ?? null,
        reads: room.reads,
      })
    ),
    minSpendUsd: null,
    dietaryNotes: null,
    hostsPrivateEvents: Boolean(cache?.venue?.hosts_private_events),
  };
}

function candidateFor(row: { venue_id: string; name: string; address: string; bucket: string; website: string }): CandidateVenue {
  return {
    placeSourceId: row.venue_id,
    name: row.name,
    formattedAddress: row.address,
    lat: 0,
    lng: 0,
    category: row.bucket,
    website: row.website || undefined,
  };
}

function main() {
  const index = readVenueIndex();
  const goldIds = new Set(
    readCsv(evalDir("gold_labels.csv"))
      .filter((row) => row.venue_status === "labeled")
      .map((row) => row.venue_id)
  );
  const groundedGold = readJsonl<CacheRoom & { venue_id: string }>(evalDir("extractions.jsonl")).filter(
    (row) => goldIds.has(row.venue_id) && row.features?.grounded && !row.extraction_failed && row.capacity > 0
  );

  const byHost = new Map<string, (typeof index)[number]>();
  for (const row of index) {
    const host = hostOf(row.website) ?? row.domain;
    if (host && !byHost.has(host)) byHost.set(host, row);
  }

  let rescored = 0;
  const couldNot: Record<string, number> = {};
  const bump = (reason: string) => {
    couldNot[reason] = (couldNot[reason] ?? 0) + 1;
  };

  const goldLabels: Array<{ venue_id: string; room: string; capacity: number; probability: number | null; label: string }> = [];

  for (const row of index) {
    const snap = loadSnapshot(row.venue_id);
    if (!snap) {
      bump("no saved snapshot");
      continue;
    }
    if (snap.fetch_outcome !== "ok" || snap.pages.length === 0) {
      bump(`snapshot ${snap.fetch_outcome}`);
      continue;
    }
    const cachePath = evalDir(".cache", "student", `${row.venue_id}.json`);
    const cache = existsSync(cachePath) ? readJson<CacheFile>(cachePath) : null;
    const signals = signalsFromPages(studentPages(snap), [], snap.website ?? "");
    const llm = llmFromCache(cache);
    const draft = buildVenueDraft(candidateFor(row), signals, llm);
    for (const room of draft.rooms) {
      if (room.isEstimate || room.confidence == null) {
        bump(room.isEstimate ? "category estimate, no number on the page" : "page had no scoreable number");
        continue;
      }
      rescored++;
    }
  }

  for (const row of groundedGold) {
    const snap = loadSnapshot(row.venue_id);
    const indexRow = index.find((venue) => venue.venue_id === row.venue_id);
    if (!snap || !indexRow || snap.pages.length === 0) {
      goldLabels.push({ venue_id: row.venue_id, room: row.room_name, capacity: row.capacity, probability: null, label: "unscored" });
      continue;
    }
    const signals = signalsFromPages(studentPages(snap), [], snap.website ?? "");
    const scored = scorePageCapacity(
      signals,
      {
        roomName: row.room_name,
        maxCapacity: row.capacity,
        minCapacity: row.min_capacity,
        evidenceQuote: row.evidence_quote ?? undefined,
        reads: row.reads,
      },
      row.capacity,
      row.evidence_quote
    );
    goldLabels.push({
      venue_id: row.venue_id,
      room: row.room_name,
      capacity: row.capacity,
      probability: scored.confidence,
      label: scored.confidence == null ? "unscored" : trustFromConfidence(scored.confidence),
    });
  }

  const labelCounts = goldLabels.reduce<Record<string, number>>((counts, row) => {
    counts[row.label] = (counts[row.label] ?? 0) + 1;
    return counts;
  }, {});

  const seedNumberRooms = seedVenues.reduce((n, venue) => n + venue.rooms.filter((room) => !room.isEstimate).length, 0);
  const seedEstimateRooms = seedVenues.reduce((n, venue) => n + venue.rooms.filter((room) => room.isEstimate).length, 0);

  const database = { seed_rooms_set_planner: 0, auto_rooms_updated: 0, auto_rooms_left: 0, skipped: "" };

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    database.skipped = "Supabase is not configured, so the database was left as it is.";
  } else {
    const supabase = createClient(url, serviceKey) as unknown as Db;
    const seedUpdate = awaitSeed(supabase, database);
    const autoUpdate = awaitAuto(supabase, byHost, database);
    return Promise.all([seedUpdate, autoUpdate]).then(() => finish(rescored, couldNot, goldLabels, labelCounts, seedNumberRooms, seedEstimateRooms, database));
  }

  finish(rescored, couldNot, goldLabels, labelCounts, seedNumberRooms, seedEstimateRooms, database);
}

function finish(
  rescored: number,
  couldNot: Record<string, number>,
  goldLabels: unknown,
  labelCounts: Record<string, number>,
  seedNumberRooms: number,
  seedEstimateRooms: number,
  database: { seed_rooms_set_planner: number; auto_rooms_updated: number; auto_rooms_left: number; skipped: string }
) {
  const result = {
    rescored_rooms: rescored,
    could_not_rescore: couldNot,
    seed_venues: seedVenues.length,
    seed_number_rooms_treated_as_planner_confirmed: seedNumberRooms,
    seed_estimate_rooms_left_as_estimates: seedEstimateRooms,
    gold_displayed_numbers: goldLabels,
    gold_label_counts: labelCounts,
    database,
  };
  writeJsonAtomic(evalDir("results", "backfill_confidence.json"), result);
  console.log(JSON.stringify({ ...result, gold_displayed_numbers: labelCounts }, null, 2));
}

type EqResult = { data: unknown; error: { message: string } | null };

function asRows<T>(data: unknown): T[] {
  return Array.isArray(data) ? (data as T[]) : [];
}
type Query = PromiseLike<EqResult> & {
  select(columns: string): Query;
  eq(column: string, value: string | boolean): Query;
  update(values: Record<string, unknown>): { eq(column: string, value: string): Promise<{ error: { message: string } | null }> };
};
type Db = { from(table: string): Query };

async function awaitSeed(
  supabase: Db,
  database: { seed_rooms_set_planner: number; skipped: string }
) {
  const { data: venues, error } = await supabase.from("venues").select("id").eq("source", "curated_seed");
  if (error || !venues) {
    database.seed_rooms_set_planner = 0;
    if (error) database.skipped = error.message;
    return;
  }
  for (const venue of asRows<{ id: string }>(venues)) {
    const { data: rooms } = await supabase
      .from("venue_rooms")
      .select("id, is_estimate")
      .eq("venue_id", venue.id)
      .eq("is_estimate", false);
    for (const room of asRows<{ id: string }>(rooms)) {
      const { error: updateError } = await supabase
        .from("venue_rooms")
        .update({
          capacity_trust: "confirmed_by_planner",
          capacity_confidence: PLANNER_CONFIDENCE,
          confidence_features: featureLog("planner", null),
        })
        .eq("id", room.id);
      if (!updateError) database.seed_rooms_set_planner++;
    }
  }
}

async function awaitAuto(
  supabase: Db,
  byHost: Map<string, { venue_id: string; name: string; address: string; bucket: string; website: string }>,
  database: { auto_rooms_updated: number; auto_rooms_left: number; skipped: string }
) {
  const { data: venues, error } = await supabase.from("venues").select("id, website").eq("source", "auto_discovered");
  if (error || !venues) {
    if (error) database.skipped = error.message;
    return;
  }
  for (const venue of asRows<{ id: string; website: string | null }>(venues)) {
    const row = byHost.get(hostOf(venue.website) ?? "");
    const snap = row ? loadSnapshot(row.venue_id) : null;
    const { data: rooms } = await supabase
      .from("venue_rooms")
      .select("id, room_name, max_capacity, is_estimate, evidence_quote")
      .eq("venue_id", venue.id);
    for (const room of asRows<{ id: string; room_name: string; max_capacity: number; is_estimate: boolean; evidence_quote: string | null }>(rooms)) {
      if (room.is_estimate || !snap || snap.fetch_outcome !== "ok" || snap.pages.length === 0 || !row) {
        database.auto_rooms_left++;
        continue;
      }
      const cachePath = evalDir(".cache", "student", `${row.venue_id}.json`);
      const cache = existsSync(cachePath) ? readJson<CacheFile>(cachePath) : null;
      const llmRoom = llmFromCache(cache)?.rooms.find((item) => item.roomName === room.room_name) ?? null;
      const signals = signalsFromPages(studentPages(snap), [], snap.website ?? "");
      const scored = scorePageCapacity(signals, llmRoom, room.max_capacity, room.evidence_quote);
      if (scored.confidence == null) {
        database.auto_rooms_left++;
        continue;
      }
      const { error: updateError } = await supabase
        .from("venue_rooms")
        .update({
          capacity_trust: scored.capacityTrust,
          capacity_confidence: scored.confidence,
          confidence_features: featureLog(llmRoom ? "llm" : "regex", scored.features),
        })
        .eq("id", room.id);
      if (updateError) database.auto_rooms_left++;
      else database.auto_rooms_updated++;
    }
  }
}

main();
