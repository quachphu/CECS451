/**
 * Step 8: build the train and test tables for the three models.
 *
 *   npx tsx scripts/data/08_build_tables.ts
 *
 * Splits by website domain: test = all gold venues + all LA venues (LA
 * non-gold venues keep the human-accepted labels and are reported separately); train =
 * every other venue the human labeled. The gold label wins where it exists;
 * `label_source` records that. `teacher` and `teacher_human_confirmed` are pipeline field names. Writes:
 *   eval/train_confidence.csv, eval/test_confidence.csv   (one row per extracted room)
 *   eval/train_discovery.csv,  eval/test_discovery.csv    (one row per venue)
 *   eval/fit_prior_venues.csv                             (largest labeled room per venue)
 *   eval/results/data_funnel.json, and the funnel table in eval/DATA_CARD.md
 * Asserts that no gold or LA venue and no test domain reaches a training file.
 */
import { existsSync, readFileSync } from "node:fs";
import type { Bucket } from "../../src/lib/discovery/category-buckets";
import {
  canonicalRoomName,
  FULL_BUYOUT,
} from "../../src/lib/discovery/room-normalize";
import type { ExtractionRow, ExtractionVenue } from "./04_extract_student";
import type { TeacherLabel } from "./06_build_review_sheets";
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
  assertNoLeakage,
  assignSplits,
  CONFIDENCE_COLUMNS,
  confidenceRow,
  DISCOVERY_COLUMNS,
  discoveryRow,
  type VenueLabel,
  v0Prior,
} from "./lib/tables";
import { loadSnapshot, readVenueIndex } from "./lib/venue-index";

const CITIES = ["NYC", "SF", "Honolulu", "LA"];
const int = (s: string | undefined) =>
  s && Number(s) > 0 ? Math.round(Number(s)) : null;

function main() {
  const manifest = new RunManifest("08_build_tables");
  const index = readVenueIndex();
  const teacher = new Map(
    readJsonl<TeacherLabel>(evalDir("teacher_labels.jsonl")).map((t) => [
      t.venue_id,
      t,
    ]),
  );
  const goldRows = readCsv(evalDir("gold_labels.csv"));
  const goldIds = new Set(
    readCsv(evalDir("gold_venues.csv")).map((g) => g.venue_id),
  );
  if (goldRows.length === 0)
    console.warn(
      "No gold_labels.csv yet: every test row will use the human-accepted draft.",
    );

  // Labels: the human gold label where it exists, otherwise the human-accepted draft.
  const labels = new Map<string, VenueLabel>();
  for (const [id, t] of teacher) {
    labels.set(id, {
      venueId: id,
      source: "teacher",
      status: t.status,
      hosts: t.hosts_private_events,
      rooms:
        t.status === "labeled"
          ? t.rooms.map((r) => ({
              roomName: canonicalRoomName(r.room_name),
              seatedMax: r.seated_max,
              standingMax: r.standing_max,
              min: r.min,
            }))
          : [],
      totalSeats: t.total_seats,
    });
  }
  const goldByVenue = new Map<string, Array<Record<string, string>>>();
  for (const g of goldRows)
    goldByVenue.set(g.venue_id, [...(goldByVenue.get(g.venue_id) ?? []), g]);
  for (const [id, rows] of goldByVenue) {
    labels.set(id, {
      venueId: id,
      source: rows[0].source === "teacher_human_confirmed" ? "teacher_human_confirmed" : "gold",
      status: rows[0].venue_status === "unclear" ? "unclear" : "labeled",
      hosts: (rows[0].hosts_private_events || "unknown") as VenueLabel["hosts"],
      rooms: rows
        .filter((r) => r.room_name)
        .map((r) => ({
          roomName: canonicalRoomName(r.room_name),
          seatedMax: int(r.seated_max),
          standingMax: int(r.standing_max),
          min: int(r.min),
        })),
      // Reviewers don't record total seats; the draft's total stands in for buyout matching.
      totalSeats: teacher.get(id)?.total_seats ?? null,
    });
  }

  const inData = index.filter((v) => v.in_dataset === "1");
  const splits = assignSplits(
    inData.map((v) => ({
      venueId: v.venue_id,
      domain: v.domain,
      city: v.city,
    })),
    goldIds,
  );
  const byId = new Map(index.map((v) => [v.venue_id, v]));
  const meta = (id: string) => {
    const v = byId.get(id)!;
    return {
      venue_id: id,
      domain: v.domain,
      city: v.city,
      bucket: v.bucket,
      split: splits.get(id)!,
    };
  };

  // Confidence table.
  const exclusions: Record<string, number> = {};
  const confRows: Array<Record<string, string | number>> = [];
  for (const ex of readJsonl<ExtractionRow>(evalDir("extractions.jsonl"))) {
    if (!splits.has(ex.venue_id)) continue;
    const label = labels.get(ex.venue_id);
    const train = splits.get(ex.venue_id) === "train";
    // Training uses only venues the human labeled; test rows use the human label.
    const out = confidenceRow(
      ex,
      train && label?.source !== "teacher" ? undefined : label,
    );
    if ("excluded" in out)
      exclusions[out.excluded] = (exclusions[out.excluded] ?? 0) + 1;
    else confRows.push({ ...meta(ex.venue_id), ...out.row });
  }
  const confTrain = confRows.filter((r) => r.split === "train");
  const confTest = confRows.filter((r) => r.split !== "train");
  assertNoLeakage(confTrain as never, confTest as never, goldIds);

  // Discovery table.
  const google = new Map(
    readCsv(evalDir("google_features.csv")).map((g) => [g.venue_id, g]),
  );
  const discRows: Array<Record<string, string | number | null>> = [];
  const discExcluded: Record<string, number> = {};
  for (const v of inData) {
    const label = labels.get(v.venue_id);
    if (!label) {
      discExcluded.no_label = (discExcluded.no_label ?? 0) + 1;
      continue;
    }
    if (label.hosts === "unknown") {
      discExcluded.hosts_unknown = (discExcluded.hosts_unknown ?? 0) + 1;
      continue;
    }
    const snap = loadSnapshot(v.venue_id);
    const features = discoveryRow(
      { name: v.name, bucket: v.bucket as Bucket },
      google.get(v.venue_id),
      (snap?.external_event_links.length ?? 0) > 0,
    );
    discRows.push({
      ...meta(v.venue_id),
      label_source: label.source,
      y: label.hosts === "yes" ? 1 : 0,
      ...features,
      v0_prior: Number(
        v0Prior(
          { name: v.name, bucket: v.bucket as Bucket, website: v.website },
          google.get(v.venue_id),
        ).toFixed(6),
      ),
    });
  }
  const discTrain = discRows.filter((r) => r.split === "train");
  const discTest = discRows.filter((r) => r.split !== "train");
  assertNoLeakage(discTrain as never, discTest as never, goldIds);

  // Fit-prior venues: hosts events and has at least one labeled room; largest figure per venue.
  const fitRows = inData.flatMap((v) => {
    const label = labels.get(v.venue_id);
    if (
      !label ||
      label.hosts !== "yes" ||
      label.status !== "labeled" ||
      label.rooms.length === 0
    )
      return [];
    const figures = label.rooms.flatMap((r) => [
      r.seatedMax ?? 0,
      r.standingMax ?? 0,
      r.roomName === FULL_BUYOUT ? (label.totalSeats ?? 0) : 0,
    ]);
    const max = Math.max(...figures);
    if (max <= 0) return [];
    const g = google.get(v.venue_id);
    const row = discoveryRow(
      { name: v.name, bucket: v.bucket as Bucket },
      g,
      false,
    );
    const bucket = (
      Object.keys(row).find((k) => k.startsWith("bucket_") && row[k] === 1) ??
      "bucket_casual_restaurant"
    ).slice(7);
    return [
      {
        ...meta(v.venue_id),
        fit_bucket: bucket,
        label_source: label.source,
        max_room: max,
      },
    ];
  });
  if (
    fitRows.some(
      (r) =>
        r.split === "train" && (goldIds.has(r.venue_id) || r.city === "LA"),
    )
  )
    throw new Error("fit prior leakage");

  writeCsvAtomic(
    evalDir("train_confidence.csv"),
    CONFIDENCE_COLUMNS,
    confTrain,
  );
  writeCsvAtomic(evalDir("test_confidence.csv"), CONFIDENCE_COLUMNS, confTest);
  writeCsvAtomic(evalDir("train_discovery.csv"), DISCOVERY_COLUMNS, discTrain);
  writeCsvAtomic(evalDir("test_discovery.csv"), DISCOVERY_COLUMNS, discTest);
  writeCsvAtomic(
    evalDir("fit_prior_venues.csv"),
    [
      "venue_id",
      "domain",
      "city",
      "bucket",
      "split",
      "fit_bucket",
      "label_source",
      "max_room",
    ],
    fitRows,
  );

  // Data funnel, per city.
  const extVenues = new Map(
    readJsonl<ExtractionVenue>(evalDir("extraction_venues.jsonl")).map((e) => [
      e.venue_id,
      e,
    ]),
  );
  const sampled = readCsv(evalDir("venues.csv"));
  const sampling = existsSync(evalDir("results", "sampling_report.json"))
    ? JSON.parse(
        readFileSync(evalDir("results", "sampling_report.json"), "utf8"),
      )
    : null;
  const funnel: Record<string, Record<string, number>> = {};
  for (const city of [...CITIES, "all"]) {
    const inCity = <T extends { city?: string }>(rows: T[]) =>
      city === "all" ? rows : rows.filter((r) => r.city === city);
    const idx = inCity(index);
    const outcome = (o: string[]) =>
      idx.filter((v) => o.includes(v.fetch_outcome)).length;
    const ids = new Set(idx.map((v) => v.venue_id));
    funnel[city] = {
      sampled: inCity(sampled).length,
      replacements_drawn: idx.filter((v) => v.source === "reserve").length,
      no_or_invalid_website: outcome(["no_website"]),
      robots_blocked: outcome(["robots_blocked"]),
      fetch_failed: outcome([
        "http_error",
        "timeout",
        "bot_blocked",
        "empty_after_render",
        "not_fetched",
      ]),
      parked_or_closed: outcome(["parked_or_closed"]),
      ok: outcome(["ok"]),
      extraction_failed: Array.from(ids).filter(
        (id) => extVenues.get(id)?.status === "extraction_failed",
      ).length,
      teacher_unclear: Array.from(ids).filter(
        (id) => teacher.get(id)?.status === "unclear",
      ).length,
      teacher_labeled: Array.from(ids).filter(
        (id) => teacher.get(id)?.status === "labeled",
      ).length,
      gold: Array.from(ids).filter((id) => goldIds.has(id)).length,
      confidence_train_rows: inCity(confTrain as Array<{ city?: string }>)
        .length,
      confidence_test_rows: inCity(confTest as Array<{ city?: string }>).length,
      discovery_train_rows: inCity(discTrain as Array<{ city?: string }>)
        .length,
      discovery_test_rows: inCity(discTest as Array<{ city?: string }>).length,
      fit_prior_venues: inCity(fitRows as Array<{ city?: string }>).filter(
        (r) => (r as { split?: string }).split === "train",
      ).length,
    };
  }
  const funnelDoc = {
    funnel,
    pre_sampling_drops: sampling
      ? {
          note: "Counted over the whole Foursquare extract before sampling; see run manifest.",
        }
      : null,
    exclusions: { confidence: exclusions, discovery: discExcluded },
    positives: {
      confidence_train: confTrain.filter((r) => r.y === 1).length,
      discovery_train: discTrain.filter((r) => r.y === 1).length,
    },
  };
  writeJsonAtomic(evalDir("results", "data_funnel.json"), funnelDoc);

  const steps = Object.keys(funnel.all);
  const table = [
    "| Step | " + [...CITIES, "All"].join(" | ") + " |",
    "| --- | " + [...CITIES, "All"].map(() => "---:").join(" | ") + " |",
    ...steps.map(
      (s) =>
        `| ${s.replace(/_/g, " ")} | ${[...CITIES, "all"].map((c) => funnel[c][s]).join(" | ")} |`,
    ),
  ].join("\n");
  const cardFile = evalDir("DATA_CARD.md");
  const begin = "<!-- funnel:begin -->";
  const end = "<!-- funnel:end -->";
  const block = `${begin}\n${table}\n${end}`;
  const card = existsSync(cardFile)
    ? readFileSync(cardFile, "utf8")
    : `# Data card\n\n## Data funnel\n\n${begin}\n${end}\n`;
  writeFileAtomic(
    cardFile,
    card.includes(begin)
      ? card.replace(new RegExp(`${begin}[\\s\\S]*?${end}`), block)
      : `${card}\n## Data funnel\n\n${block}\n`,
  );

  manifest.counts = {
    confidence_train: confTrain.length,
    confidence_test: confTest.length,
    discovery_train: discTrain.length,
    discovery_test: discTest.length,
    fit_prior_train_venues: fitRows.filter((r) => r.split === "train").length,
    ...Object.fromEntries(
      Object.entries(exclusions).map(([k, v]) => [
        `confidence_excluded_${k}`,
        v,
      ]),
    ),
    ...Object.fromEntries(
      Object.entries(discExcluded).map(([k, v]) => [
        `discovery_excluded_${k}`,
        v,
      ]),
    ),
  };
  manifest.inputs.push(
    evalDir("extractions.jsonl"),
    evalDir("teacher_labels.jsonl"),
    evalDir("gold_labels.csv"),
    evalDir("venue_index.csv"),
  );
  manifest.outputs.push(
    evalDir("train_confidence.csv"),
    evalDir("test_confidence.csv"),
    evalDir("train_discovery.csv"),
    evalDir("test_discovery.csv"),
    evalDir("fit_prior_venues.csv"),
    evalDir("results", "data_funnel.json"),
  );
  manifest.write();
  console.log(
    JSON.stringify(
      { counts: manifest.counts, positives: funnelDoc.positives },
      null,
      2,
    ),
  );
}

main();
