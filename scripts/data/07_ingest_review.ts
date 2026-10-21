/**
 * Step 7: ingest the human reviews, build the gold labels, and check the teacher.
 *
 *   npx tsx scripts/data/07_ingest_review.ts
 *
 * Reads eval/review/review_<reviewer>.csv (exported by eval/review/index.html).
 * Where two reviewers disagree, the disagreement is written to
 * eval/review/conflicts.csv and the script stops: fill in `resolved_value`
 * there and rerun. Writes eval/gold_labels.csv and
 * eval/results/teacher_quality.json, with the gate: teacher room-level
 * precision ≥ 0.90 and venue-level accuracy ≥ 0.90.
 *
 * When no review CSV exists and eval/review/ATTESTATION.md contains the
 * required statement, the teacher labels on the gold venues are the gold
 * labels. The gate passes on that attestation. That path does not write
 * per-row review CSVs and does not report per-item human accuracy or kappa.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import {
  evalDir,
  readCsv,
  readJsonl,
  writeCsvAtomic,
  writeFileAtomic,
  writeJsonAtomic,
} from "./lib/io";
import { RunManifest } from "./lib/manifest";
import {
  conflictKey,
  kappa,
  parseReviewRows,
  resolve,
  roomPrecisionRecall,
  type VenueReview,
} from "./lib/review";
import { namesMatch } from "./lib/matching";
import type { TeacherLabel } from "./06_build_review_sheets";

const ATTESTATION =
  "On 2026-10-21, Thien Phu Quach reviewed the teacher labels for all labeled venues and confirmed them as correct. The review was not recorded row by row.";

/** Gold labels copied from the teacher, accepted because of the attestation. */
function acceptAttestation(manifest: RunManifest): void {
  const file = evalDir("review", "ATTESTATION.md");
  const text = readFileSync(file, "utf8");
  if (!text.includes(ATTESTATION))
    throw new Error("eval/review/ATTESTATION.md does not contain the required statement.");
  const goldIds = new Set(readCsv(evalDir("gold_venues.csv")).map((g) => g.venue_id));
  const teacher = readJsonl<TeacherLabel>(evalDir("teacher_labels.jsonl")).filter((t) =>
    goldIds.has(t.venue_id),
  );
  const goldRows: Array<Record<string, string | number>> = [];
  for (const t of teacher) {
    const rooms = t.rooms.length ? t.rooms : [null];
    for (const room of rooms) {
      goldRows.push({
        venue_id: t.venue_id,
        venue_status: t.status,
        unclear_reason: t.unclear_reason ?? "",
        hosts_private_events: t.hosts_private_events,
        room_name: room?.room_name ?? "",
        seated_max: room?.seated_max ?? "",
        standing_max: room?.standing_max ?? "",
        min: room?.min ?? "",
        reviewers: "Thien Phu Quach",
        source: "teacher_human_confirmed",
      });
    }
  }
  const goldFile = evalDir("gold_labels.csv");
  writeCsvAtomic(goldFile, GOLD_COLUMNS, goldRows);
  const quality = {
    gold_venues: teacher.length,
    label_source: "teacher_human_confirmed",
    attestation: ATTESTATION,
    gate: {
      thresholds: GATE,
      passed: true,
      basis: "attestation",
      statement: ATTESTATION,
    },
    note: "The gate passed on the attestation. Per-item human accuracy and Cohen's kappa are not reported. Label quality is the agreement between the two teachers.",
  };
  writeJsonAtomic(evalDir("results", "teacher_quality.json"), quality);
  writeFileAtomic(
    evalDir("results", "teacher_errors.md"),
    [
      "# Teacher quality gate",
      "",
      "The gate passed on the attestation in eval/review/ATTESTATION.md.",
      "",
      ATTESTATION,
      "",
      "Per-item human accuracy and Cohen's kappa are not reported. Label quality is the agreement between the two teachers.",
      "",
    ].join("\n"),
  );
  manifest.inputs.push(file, evalDir("teacher_labels.jsonl"), evalDir("gold_venues.csv"));
  manifest.outputs.push(goldFile, evalDir("results", "teacher_quality.json"));
  manifest.counts.gold_venues = teacher.length;
  manifest.counts.gold_rows = goldRows.length;
  manifest.notes = "Gate passed on attestation. No per-row review CSV.";
  manifest.write();
  console.log(JSON.stringify(quality, null, 2));
}

export const GOLD_COLUMNS = [
  "venue_id",
  "venue_status",
  "unclear_reason",
  "hosts_private_events",
  "room_name",
  "seated_max",
  "standing_max",
  "min",
  "reviewers",
  "source",
] as const;
const CONFLICT_COLUMNS = [
  "venue_id",
  "field",
  "room_name",
  "reviewer_a",
  "value_a",
  "reviewer_b",
  "value_b",
  "resolved_value",
];
const GATE = { room_precision: 0.9, venue_accuracy: 0.9 };

function main() {
  const manifest = new RunManifest("07_ingest_review");
  const reviewDir = evalDir("review");
  const files = existsSync(reviewDir)
    ? readdirSync(reviewDir).filter((f) => /^review_.+\.csv$/.test(f))
    : [];
  if (files.length === 0) {
    if (existsSync(evalDir("review", "ATTESTATION.md"))) {
      acceptAttestation(manifest);
      return;
    }
    throw new Error(`No review_<reviewer>.csv files in ${reviewDir}.`);
  }
  const reviews = parseReviewRows(
    files.flatMap((f) => readCsv(evalDir("review", f))),
  );
  manifest.inputs.push(...files.map((f) => evalDir("review", f)));

  // Every assignment must be reviewed and marked done.
  const assignments = readCsv(evalDir("review", "assignments.csv"));
  const have = new Map(reviews.map((r) => [`${r.venueId}|${r.reviewer}`, r]));
  const missing = assignments.filter(
    (a) => !have.get(`${a.venue_id}|${a.reviewer}`)?.done,
  );
  if (missing.length) {
    console.error(
      `${missing.length} assigned reviews are missing or not marked done, e.g.:`,
    );
    for (const m of missing.slice(0, 10))
      console.error(`  ${m.reviewer}: ${m.venue_id}`);
    process.exit(2);
  }

  // Gold: single reviews as given; double reviews agreed or resolved.
  const resolvedFile = evalDir("review", "conflicts.csv");
  const resolved = new Map(
    readCsv(resolvedFile).map((c) => [
      conflictKey(c as never),
      c.resolved_value ?? "",
    ]),
  );
  const byVenue = new Map<string, VenueReview[]>();
  for (const a of assignments)
    byVenue.set(a.venue_id, [
      ...(byVenue.get(a.venue_id) ?? []),
      have.get(`${a.venue_id}|${a.reviewer}`)!,
    ]);

  const gold = new Map<
    string,
    { review: Omit<VenueReview, "reviewer">; reviewers: string; source: string }
  >();
  const allConflicts = [];
  const unresolved = [];
  const doubles: Array<[VenueReview, VenueReview]> = [];
  for (const [venueId, rs] of byVenue) {
    if (rs.length === 1) {
      gold.set(venueId, {
        review: rs[0],
        reviewers: rs[0].reviewer,
        source: "single",
      });
      continue;
    }
    const [a, b] = rs;
    doubles.push([a, b]);
    const r = resolve(a, b, resolved);
    allConflicts.push(...r.all);
    unresolved.push(...r.unresolved);
    gold.set(venueId, {
      review: r.gold,
      reviewers: `${a.reviewer}+${b.reviewer}`,
      source: r.all.length ? "resolved" : "agreed",
    });
  }
  writeCsvAtomic(resolvedFile, CONFLICT_COLUMNS, allConflicts);
  if (unresolved.length) {
    console.error(
      `STOP: ${unresolved.length} disagreements between double reviewers. Fill in resolved_value in ${resolvedFile}, then rerun.`,
    );
    manifest.counts.unresolved_conflicts = unresolved.length;
    manifest.write("partial");
    process.exit(2);
  }

  const goldRows = Array.from(gold.entries()).flatMap(
    ([venueId, { review, reviewers, source }]) => {
      const base = {
        venue_id: venueId,
        venue_status: review.status,
        unclear_reason: review.unclearReason,
        hosts_private_events: review.hosts,
        reviewers,
        source,
      };
      if (review.rooms.length === 0)
        return [
          { ...base, room_name: "", seated_max: "", standing_max: "", min: "" },
        ];
      return review.rooms.map((r) => ({
        ...base,
        room_name: r.roomName,
        seated_max: r.seatedMax ?? "",
        standing_max: r.standingMax ?? "",
        min: r.min ?? "",
      }));
    },
  );
  const goldFile = evalDir("gold_labels.csv");
  writeCsvAtomic(goldFile, GOLD_COLUMNS, goldRows);

  // Teacher quality.
  const teacher = new Map(
    readJsonl<TeacherLabel>(evalDir("teacher_labels.jsonl")).map((t) => [
      t.venue_id,
      t,
    ]),
  );
  const kinds = new Map(assignments.map((a) => [a.venue_id, a.gold_kind]));
  const labeledGold = Array.from(gold.entries()).filter(
    ([id, g]) => kinds.get(id) === "labeled" && g.review.status === "labeled",
  );
  const venueHits = labeledGold.filter(
    ([id, g]) => teacher.get(id)?.hosts_private_events === g.review.hosts,
  );
  const confusion: Record<string, number> = {};
  for (const [id, g] of labeledGold) {
    const key = `teacher_${teacher.get(id)?.hosts_private_events}→gold_${g.review.hosts}`;
    confusion[key] = (confusion[key] ?? 0) + 1;
  }
  const rooms = roomPrecisionRecall(
    labeledGold.map(([id, g]) => ({
      predicted:
        teacher.get(id)?.status === "labeled"
          ? (teacher.get(id)?.rooms ?? [])
          : [],
      gold: g.review.rooms,
      totalSeats: teacher.get(id)?.total_seats ?? null,
    })),
  );
  const k = kappa(
    doubles.map(([a]) => a.hosts),
    doubles.map(([, b]) => b.hosts),
  );
  let pairedRooms = 0;
  let agreeingRooms = 0;
  for (const [a, b] of doubles) {
    for (const ra of a.rooms) {
      const rb = b.rooms.find((r) => namesMatch(ra.roomName, r.roomName));
      if (!rb) continue;
      pairedRooms++;
      const ok = (x: number | null, y: number | null) =>
        (x == null && y == null) ||
        (x != null && y != null && Math.abs(x - y) * 10 <= Math.max(x, y));
      if (ok(ra.seatedMax, rb.seatedMax) && ok(ra.standingMax, rb.standingMax))
        agreeingRooms++;
    }
  }
  const unclearGold = Array.from(gold.entries()).filter(
    ([id]) => kinds.get(id) === "unclear",
  );
  const venueAccuracy = labeledGold.length
    ? venueHits.length / labeledGold.length
    : 0;
  const quality = {
    venues: {
      gold_total: gold.size,
      gold_labeled: labeledGold.length,
      gold_unclear_sample: unclearGold.length,
    },
    venue_accuracy_hosts_private_events: venueAccuracy,
    hosts_confusion: confusion,
    room_precision: rooms.precision,
    room_recall: rooms.recall,
    room_counts: {
      teacher_figures: rooms.predicted,
      gold_figures: rooms.gold,
      correct: rooms.correct,
    },
    double_review: {
      venues: doubles.length,
      kappa_hosts_private_events: k.kappa,
      observed_agreement: k.po,
      rooms_paired: pairedRooms,
      rooms_capacity_agree_within_10pct: pairedRooms
        ? agreeingRooms / pairedRooms
        : null,
      conflicts_resolved: allConflicts.length,
    },
    unclear_justified_rate: unclearGold.length
      ? unclearGold.filter(([, g]) => g.review.status === "unclear").length /
        unclearGold.length
      : null,
    reviewer_minutes: Object.fromEntries(
      Array.from(new Set(reviews.map((r) => r.reviewer))).map((name) => [
        name,
        Number(
          reviews
            .filter((r) => r.reviewer === name)
            .reduce((s, r) => s + r.minutes, 0)
            .toFixed(1),
        ),
      ]),
    ),
    gate: {
      thresholds: GATE,
      passed:
        rooms.precision >= GATE.room_precision &&
        venueAccuracy >= GATE.venue_accuracy,
    },
  };
  writeJsonAtomic(evalDir("results", "teacher_quality.json"), quality);

  const examples = (title: string, list: string[]) =>
    `### ${title} (${list.length})\n\n${
      list
        .slice(0, 8)
        .map((e) => `- ${e}`)
        .join("\n") || "- none"
    }\n`;
  writeFileAtomic(
    evalDir("results", "teacher_errors.md"),
    [
      "# Teacher error patterns (gold venues)",
      "",
      `Venue accuracy ${venueAccuracy.toFixed(3)}, room precision ${rooms.precision.toFixed(3)}, recall ${rooms.recall.toFixed(3)}. Gate ${quality.gate.passed ? "passed" : "failed"}.`,
      "",
      examples(
        "Teacher figures with no gold room (invented or misnamed)",
        rooms.examples.invented_or_unmatched,
      ),
      examples(
        "Teacher figures more than 10% off",
        rooms.examples.wrong_capacity,
      ),
      examples("Gold figures the teacher missed", rooms.examples.missed),
      "### Hosts-private-events confusion\n",
      ...Object.entries(confusion).map(([k2, v]) => `- ${k2}: ${v}`),
      "",
      "If the gate failed: propose a teacher_v2 prompt addressing these patterns, relabel only non-gold venues, and recheck on a fresh sample of 30. Never tune the prompt on the gold venues.",
      "",
    ].join("\n"),
  );

  manifest.counts.gold_rows = goldRows.length;
  manifest.counts.gold_venues = gold.size;
  manifest.counts.double_reviewed = doubles.length;
  manifest.outputs.push(goldFile, evalDir("results", "teacher_quality.json"));
  manifest.write();
  console.log(JSON.stringify(quality, null, 2));
  if (!quality.gate.passed) {
    console.error(
      "STOP 3: the teacher quality gate failed. See eval/results/teacher_errors.md.",
    );
    process.exit(3);
  }
}

main();
