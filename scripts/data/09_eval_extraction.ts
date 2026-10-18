/**
 * Step 13 (extraction table): compare extraction methods on the gold venues.
 *
 *   npx tsx scripts/data/09_eval_extraction.ts
 *
 * Methods, all from the same snapshot text the student saw:
 *   v0_regex_max        the original "largest number on the page" logic (estimates left out)
 *   regex_candidates    every capacity candidate the regex finds
 *   grok_single_read    the first successful Grok read, ungrounded rooms included
 *   grok_grounded_sc    the shipped path: k reads, modal capacity, grounded rooms only
 * Writes eval/results/extraction_eval.json (all gold, and LA gold separately).
 */
import { extractCapacityCandidates, signalsFromPages } from "../../src/lib/discovery/scraper";
import { canonicalRoomName } from "../../src/lib/discovery/room-normalize";
import { v0Rooms } from "../../eval/baselines";
import type { ExtractionRow } from "./04_extract_student";
import type { TeacherLabel } from "./06_build_review_sheets";
import { scoreExtraction } from "./lib/extraction-eval";
import { evalDir, readCsv, readJsonl, writeJsonAtomic } from "./lib/io";
import { RunManifest } from "./lib/manifest";
import type { ExtractedRoom, LabelRoom } from "./lib/matching";
import { studentInput } from "./lib/student-input";
import { loadSnapshot, readVenueIndex } from "./lib/venue-index";

const METHODS = ["v0_regex_max", "regex_candidates", "grok_single_read", "grok_grounded_sc"] as const;
type Method = (typeof METHODS)[number];

const int = (s: string | undefined) => (s && Number(s) > 0 ? Math.round(Number(s)) : null);

function main() {
  const manifest = new RunManifest("09_eval_extraction");
  const index = new Map(readVenueIndex().map((v) => [v.venue_id, v]));
  const teacher = new Map(readJsonl<TeacherLabel>(evalDir("teacher_labels.jsonl")).map((t) => [t.venue_id, t]));
  const extractions = readJsonl<ExtractionRow>(evalDir("extractions.jsonl"));
  const goldRows = readCsv(evalDir("gold_labels.csv"));
  const gold = new Map<string, LabelRoom[]>();
  for (const g of goldRows) {
    if (g.venue_status !== "labeled") continue;
    const rooms = gold.get(g.venue_id) ?? [];
    if (g.room_name)
      rooms.push({
        roomName: canonicalRoomName(g.room_name),
        seatedMax: int(g.seated_max),
        standingMax: int(g.standing_max),
        min: int(g.min),
      });
    gold.set(g.venue_id, rooms);
  }

  const perMethod: Record<Method, Array<{ id: string; predicted: ExtractedRoom[]; gold: LabelRoom[]; totalSeats: number | null }>> = {
    v0_regex_max: [],
    regex_candidates: [],
    grok_single_read: [],
    grok_grounded_sc: [],
  };
  let v0Estimates = 0;
  for (const [id, goldRooms] of gold) {
    const venue = index.get(id);
    const snap = loadSnapshot(id);
    if (!venue || !snap) continue;
    const totalSeats = teacher.get(id)?.total_seats ?? null;
    const { input, privateDiningPageFound, pages } = studentInput(snap);
    const combined = signalsFromPages(pages, [], snap.website ?? "").combinedText;
    const asRoom = (name: string, capacity: number, style: ExtractedRoom["style"], i: number): ExtractedRoom => ({
      roomKey: `${id}#${i}`,
      roomName: canonicalRoomName(name),
      style,
      capacity,
    });

    const v0 = v0Rooms(combined, privateDiningPageFound, venue.bucket);
    v0Estimates += v0.filter((r) => r.isEstimate).length;
    const seen = new Set<string>();
    const candidates = extractCapacityCandidates(input).filter((c) => {
      const key = `${c.roomHint ?? ""}|${c.value}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const rows = extractions.filter((r) => r.venue_id === id && !r.extraction_failed);
    const predicted: Record<Method, ExtractedRoom[]> = {
      v0_regex_max: v0.filter((r) => !r.isEstimate).map((r, i) => asRoom(r.roomName, r.maxCapacity, "unspecified", i)),
      regex_candidates: candidates.map((c, i) => asRoom(c.roomHint ?? "", c.value, "unspecified", i)),
      grok_single_read: rows
        .filter((r) => r.reads[0] != null)
        .map((r, i) => asRoom(r.room_name, r.reads[0]!, r.style, i)),
      grok_grounded_sc: rows.filter((r) => r.features?.grounded).map((r, i) => asRoom(r.room_name, r.capacity, r.style, i)),
    };
    for (const m of METHODS) perMethod[m].push({ id, predicted: predicted[m], gold: goldRooms, totalSeats });
  }

  const isLa = (id: string) => index.get(id)?.city === "LA";
  const result = {
    note: "Room-level, per stated figure; correct = within 10% of the matched gold figure. v0 category estimates are left out of v0_regex_max (it guessed a number when none was on the page).",
    v0_estimates_left_out: v0Estimates,
    test_gold: Object.fromEntries(METHODS.map((m) => [m, scoreExtraction(perMethod[m])])),
    test_la_gold: Object.fromEntries(METHODS.map((m) => [m, scoreExtraction(perMethod[m].filter((v) => isLa(v.id)))])),
  };
  const out = evalDir("results", "extraction_eval.json");
  writeJsonAtomic(out, result);
  manifest.inputs.push(evalDir("gold_labels.csv"), evalDir("extractions.jsonl"));
  manifest.outputs.push(out);
  manifest.counts.gold_venues_scored = perMethod.grok_grounded_sc.length;
  manifest.write();
  console.log(JSON.stringify(result.test_gold, null, 2));
}

main();
