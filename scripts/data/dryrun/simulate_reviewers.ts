/**
 * Dry run, part 4: stands in for the four human reviewers.
 *
 *   npx tsx scripts/data/dryrun/simulate_reviewers.ts <world.json>            # write review_<reviewer>.csv
 *   npx tsx scripts/data/dryrun/simulate_reviewers.ts <world.json> --resolve  # fill conflicts.csv
 *
 * A simulated reviewer labels what a careful person would from the saved
 * pages: the true rooms whose name appears in the snapshot. The second
 * reviewer of some double-reviewed venues mistypes a figure, so the conflict
 * path of 07_ingest_review.ts runs; --resolve settles each conflict from the truth.
 */
import { readFileSync } from "node:fs";
import { canonicalRoomName } from "../../../src/lib/discovery/room-normalize";
import type { TeacherLabel } from "../06_build_review_sheets";
import { evalDir, readCsv, readJsonl, seededRandom, writeCsvAtomic } from "../lib/io";
import { loadSnapshot } from "../lib/venue-index";
import type { WorldVenue } from "./world";

const COLUMNS = [
  "venue_id",
  "reviewer",
  "venue_status",
  "unclear_reason",
  "hosts_private_events",
  "room_name",
  "seated_max",
  "standing_max",
  "min",
  "teacher_room_correct",
  "room_exists",
  "notes",
  "minutes_spent",
  "done",
];

const worldFile = process.argv[2];
if (!worldFile) throw new Error("usage: simulate_reviewers.ts <world.json> [--resolve]");
const world: WorldVenue[] = JSON.parse(readFileSync(worldFile, "utf8"));
const byFsq = new Map(world.map((v) => [v.fsq_place_id, v]));
const venues = new Map(
  [...readCsv(evalDir("venues.csv")), ...readCsv(evalDir("venues_reserve.csv"))].map((v) => [v.venue_id, v])
);
const truthOf = (venueId: string) => byFsq.get(venues.get(venueId)?.fsq_place_id ?? "")!;

function visibleRooms(venueId: string) {
  const truth = truthOf(venueId);
  const snap = loadSnapshot(venueId);
  const text = (snap?.pages ?? []).map((p) => p.text).join(" ");
  return truth.rooms.filter((r) =>
    r.name === "Full buyout" ? /full buyout/i.test(text) : r.name.split("+").every((part) => text.includes(part))
  );
}

function review() {
  const rand = seededRandom(4510);
  const teacher = new Map(readJsonl<TeacherLabel>(evalDir("teacher_labels.jsonl")).map((t) => [t.venue_id, t]));
  const assignments = readCsv(evalDir("review", "assignments.csv"));
  const seenDouble = new Set<string>();
  const out = new Map<string, Array<Record<string, string | number>>>();
  for (const a of assignments) {
    const truth = truthOf(a.venue_id);
    const second = a.double === "true" || a.double === "1" ? seenDouble.has(a.venue_id) : false;
    seenDouble.add(a.venue_id);
    const unclear = truth.site === "multi_location";
    const rooms = unclear ? [] : visibleRooms(a.venue_id).map((r) => ({ ...r }));
    let hosts: string = truth.site === "non_english" ? "yes" : truth.hosts;
    if (second && rand() < 0.2 && rooms.length) {
      const r = rooms[0];
      if (r.seated) r.seated = Math.round(r.seated * 1.3);
      else if (r.standing) r.standing = Math.round(r.standing * 1.3);
    }
    if (second && rand() < 0.04) hosts = "unknown";
    const t = teacher.get(a.venue_id);
    const base = {
      venue_id: a.venue_id,
      reviewer: a.reviewer,
      venue_status: unclear ? "unclear" : "labeled",
      unclear_reason: unclear ? "Several locations; can't tell which rooms are at this address." : "",
      hosts_private_events: hosts,
      notes: "",
      minutes_spent: (2 + rand() * 5).toFixed(1),
      done: "1",
    };
    const rows: Array<Record<string, string | number>> = rooms.map((r) => {
      const tr = t?.rooms.find((x) => canonicalRoomName(x.room_name) === canonicalRoomName(r.name));
      const same = tr && tr.seated_max === r.seated && tr.standing_max === r.standing;
      return {
        ...base,
        room_name: r.name,
        seated_max: r.seated ?? "",
        standing_max: r.standing ?? "",
        min: r.min ?? "",
        teacher_room_correct: tr ? (same ? "yes" : "fixed") : "added",
        room_exists: "yes",
      };
    });
    for (const tr of t?.rooms ?? []) {
      if (!rooms.some((r) => canonicalRoomName(r.name) === canonicalRoomName(tr.room_name)))
        rows.push({ ...base, room_name: tr.room_name, seated_max: "", standing_max: "", min: "", teacher_room_correct: "no", room_exists: "no" });
    }
    if (rows.length === 0)
      rows.push({ ...base, room_name: "", seated_max: "", standing_max: "", min: "", teacher_room_correct: "", room_exists: "" });
    out.set(a.reviewer, [...(out.get(a.reviewer) ?? []), ...rows]);
  }
  for (const [reviewer, rows] of out) writeCsvAtomic(evalDir("review", `review_${reviewer}.csv`), COLUMNS, rows);
  console.log(`wrote ${out.size} review files, ${assignments.length} assignments`);
}

function resolveConflicts() {
  const file = evalDir("review", "conflicts.csv");
  const rows = readCsv(file);
  for (const c of rows) {
    const truth = truthOf(c.venue_id);
    const room = truth.rooms.find((r) => canonicalRoomName(r.name) === c.room_name);
    if (c.field === "hosts_private_events") c.resolved_value = truth.site === "non_english" ? "yes" : truth.hosts;
    else if (c.field === "venue_status") c.resolved_value = truth.site === "multi_location" ? "unclear" : "labeled";
    else if (c.field === "room_exists") c.resolved_value = room ? "yes" : "no";
    else if (c.field === "seated_max") c.resolved_value = String(room?.seated ?? "");
    else if (c.field === "standing_max") c.resolved_value = String(room?.standing ?? "");
  }
  writeCsvAtomic(file, ["venue_id", "field", "room_name", "reviewer_a", "value_a", "reviewer_b", "value_b", "resolved_value"], rows);
  console.log(`resolved ${rows.length} conflicts`);
}

if (process.argv.includes("--resolve")) resolveConflicts();
else review();
