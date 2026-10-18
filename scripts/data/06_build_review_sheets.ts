/**
 * Step 6: the human check — choose the gold venues, assign reviewers, and
 * write one review sheet per reviewer for eval/review/index.html.
 *
 *   npx tsx scripts/data/06_build_review_sheets.ts
 *
 * Gold set: 120 teacher-"labeled" venues stratified by city × bucket, plus 10
 * teacher-"unclear" venues (to check that "unclear" was justified), seed 451.
 * Four reviewers; 24 venues go to two reviewers (6 per rotating pair) to
 * measure agreement. Sheets carry the saved page text and the teacher's label
 * only — never the student's output — and are gitignored (page text).
 */
import { existsSync } from "node:fs";
import {
  cliArgs,
  evalDir,
  readJsonl,
  seededRandom,
  seededShuffle,
  writeCsvAtomic,
  writeJsonAtomic,
} from "./lib/io";
import { RunManifest } from "./lib/manifest";
import { loadSnapshot, readVenueIndex } from "./lib/venue-index";

export const REVIEWERS = ["Christopher", "Albert", "Han", "Phu"] as const;
const GOLD_LABELED = 120;
const GOLD_UNCLEAR = 10;
const DOUBLE_PER_PAIR = 6;

export type TeacherLabel = {
  venue_id: string;
  status: "labeled" | "unclear";
  unclear_reason?: string | null;
  hosts_private_events: "yes" | "no" | "unknown";
  rooms: Array<{
    room_name: string;
    seated_max: number | null;
    standing_max: number | null;
    min: number | null;
    quote: string;
  }>;
  min_spend_usd: number | null;
  total_seats: number | null;
  info_maybe_elsewhere: boolean;
  teacher_model: string;
  prompt_version: string;
};

/** Proportional allocation of `n` across strata (largest remainder), capped by stratum size. */
export function proportional(
  sizes: Map<string, number>,
  n: number,
): Map<string, number> {
  const total = Array.from(sizes.values()).reduce((a, b) => a + b, 0);
  const out = new Map<string, number>();
  if (total <= n) return new Map(sizes);
  const exact = Array.from(sizes.entries()).map(([k, s]) => ({
    k,
    s,
    e: (n * s) / total,
  }));
  let given = 0;
  for (const x of exact) {
    out.set(x.k, Math.min(x.s, Math.floor(x.e)));
    given += out.get(x.k)!;
  }
  for (const x of [...exact].sort(
    (a, b) =>
      b.e - Math.floor(b.e) - (a.e - Math.floor(a.e)) || a.k.localeCompare(b.k),
  )) {
    if (given >= n) break;
    if (out.get(x.k)! < x.s) {
      out.set(x.k, out.get(x.k)! + 1);
      given++;
    }
  }
  return out;
}

/** Rotating pairs (A,B) (B,C) (C,D) (D,A), six double-reviewed venues each. */
export function pairs(): Array<[string, string]> {
  return REVIEWERS.map(
    (r, i) => [r, REVIEWERS[(i + 1) % REVIEWERS.length]] as [string, string],
  );
}

export function assign(
  labeled: string[],
  unclear: string[],
  rand: () => number,
): Array<{
  venue_id: string;
  reviewer: string;
  double: boolean;
  gold_kind: "labeled" | "unclear";
}> {
  const shuffled = seededShuffle(labeled, rand);
  const doubles = shuffled.slice(0, DOUBLE_PER_PAIR * pairs().length);
  const singles = [
    ...shuffled.slice(doubles.length),
    ...seededShuffle(unclear, rand),
  ];
  const load = new Map<string, number>(REVIEWERS.map((r) => [r, 0]));
  const rows: Array<{
    venue_id: string;
    reviewer: string;
    double: boolean;
    gold_kind: "labeled" | "unclear";
  }> = [];
  pairs().forEach(([a, b], p) => {
    for (const venue_id of doubles.slice(
      p * DOUBLE_PER_PAIR,
      (p + 1) * DOUBLE_PER_PAIR,
    )) {
      for (const reviewer of [a, b]) {
        rows.push({ venue_id, reviewer, double: true, gold_kind: "labeled" });
        load.set(reviewer, load.get(reviewer)! + 1);
      }
    }
  });
  // Singles go to whoever has the least work so far (ties in reviewer order).
  const unclearSet = new Set(unclear);
  for (const venue_id of singles) {
    const reviewer = [...REVIEWERS].sort(
      (x, y) => load.get(x)! - load.get(y)!,
    )[0];
    rows.push({
      venue_id,
      reviewer,
      double: false,
      gold_kind: unclearSet.has(venue_id) ? "unclear" : "labeled",
    });
    load.set(reviewer, load.get(reviewer)! + 1);
  }
  return rows;
}

function main() {
  const { flags } = cliArgs();
  const manifest = new RunManifest("06_build_review_sheets");
  const labelsFile = evalDir("teacher_labels.jsonl");
  if (!existsSync(labelsFile))
    throw new Error(`${labelsFile} not found; run 05_label_teacher.py first.`);
  const assignmentsFile = evalDir("review", "assignments.csv");
  if (existsSync(assignmentsFile) && !flags.has("force")) {
    throw new Error(
      `${assignmentsFile} exists; reviewers may already be working. Use --force to redraw.`,
    );
  }
  const index = new Map(readVenueIndex().map((v) => [v.venue_id, v]));
  const labels = readJsonl<TeacherLabel>(labelsFile);
  const byId = new Map(labels.map((l) => [l.venue_id, l]));
  const rand = seededRandom();

  // Stratified draw of labeled venues.
  const strata = new Map<string, string[]>();
  for (const l of labels.filter((l) => l.status === "labeled")) {
    const v = index.get(l.venue_id);
    if (!v) continue;
    const key = `${v.city}/${v.bucket}`;
    strata.set(key, [...(strata.get(key) ?? []), l.venue_id]);
  }
  const plan = proportional(
    new Map(Array.from(strata.entries()).map(([k, ids]) => [k, ids.length])),
    GOLD_LABELED,
  );
  const goldLabeled: string[] = [];
  for (const key of Array.from(strata.keys()).sort()) {
    goldLabeled.push(
      ...seededShuffle([...strata.get(key)!].sort(), rand).slice(
        0,
        plan.get(key) ?? 0,
      ),
    );
  }
  const unclearPool = labels
    .filter((l) => l.status === "unclear" && index.has(l.venue_id))
    .map((l) => l.venue_id)
    .sort();
  const goldUnclear = seededShuffle(unclearPool, rand).slice(0, GOLD_UNCLEAR);
  const rows = assign(goldLabeled, goldUnclear, rand);

  writeCsvAtomic(
    assignmentsFile,
    ["venue_id", "reviewer", "double", "gold_kind"],
    rows.map((r) => ({ ...r, double: r.double ? 1 : 0 })),
  );
  writeCsvAtomic(
    evalDir("gold_venues.csv"),
    ["venue_id", "gold_kind", "double", "city", "bucket", "domain"],
    Array.from(new Map(rows.map((r) => [r.venue_id, r])).values()).map((r) => {
      const v = index.get(r.venue_id)!;
      return {
        venue_id: r.venue_id,
        gold_kind: r.gold_kind,
        double: r.double ? 1 : 0,
        city: v.city,
        bucket: v.bucket,
        domain: v.domain,
      };
    }),
  );

  for (const reviewer of REVIEWERS) {
    const mine = rows.filter((r) => r.reviewer === reviewer);
    const venues = mine.map((r) => {
      const v = index.get(r.venue_id)!;
      const snap = loadSnapshot(r.venue_id)!;
      const t = byId.get(r.venue_id)!;
      return {
        venue_id: r.venue_id,
        name: v.name,
        address: v.address,
        city: v.city,
        bucket: v.bucket,
        website: v.website,
        double: r.double,
        pages: snap.pages.map((p) => ({
          url: p.url,
          kind: p.kind,
          text: p.text,
        })),
        external_event_links: snap.external_event_links,
        teacher: {
          status: t.status,
          unclear_reason: t.unclear_reason ?? null,
          hosts_private_events: t.hosts_private_events,
          rooms: t.rooms,
          total_seats: t.total_seats,
          min_spend_usd: t.min_spend_usd,
          info_maybe_elsewhere: t.info_maybe_elsewhere,
        },
      };
    });
    writeJsonAtomic(evalDir("review", "sheets", `${reviewer}.json`), {
      reviewer,
      created_at: new Date().toISOString(),
      venues,
    });
    manifest.counts[`load_${reviewer}`] = venues.length;
  }

  manifest.counts.gold_labeled = goldLabeled.length;
  manifest.counts.gold_unclear = goldUnclear.length;
  manifest.counts.double_reviewed = rows.filter((r) => r.double).length / 2;
  manifest.counts.strata = strata.size;
  manifest.inputs.push(labelsFile);
  manifest.outputs.push(assignmentsFile, evalDir("gold_venues.csv"));
  manifest.write();
  console.log(
    `Gold: ${goldLabeled.length} labeled + ${goldUnclear.length} unclear; ${manifest.counts.double_reviewed} double-reviewed.`,
  );
  for (const r of REVIEWERS)
    console.log(
      `  ${r}: ${manifest.counts[`load_${r}`]} venues → ${evalDir("review", "sheets", `${r}.json`)}`,
    );
}

main();
