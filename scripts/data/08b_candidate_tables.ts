/**
 * Candidate, event-content discovery, and hosts-yes fit tables from saved data.
 *
 *   npx tsx scripts/data/08b_candidate_tables.ts
 *
 * No network. Gold venues and LA domains stay out of every training file.
 * Writes eval/train_candidates.csv, eval/test_candidates.csv,
 * eval/train_discovery_event.csv, eval/test_discovery_event.csv,
 * and eval/fit_prior_hosts.csv.
 */
import { existsSync } from "node:fs";
import type { Bucket } from "../../src/lib/discovery/category-buckets";
import {
  CANDIDATE_FEATURE_ORDER,
  encodeCandidateFeatures,
} from "../../src/lib/discovery/features";
import { PRIVATE_DINING_KEYWORDS } from "../../src/lib/discovery/scraper";
import {
  clusterNumberHits,
  extractPageNumberCandidates,
  withinRelative,
  type NumberHit,
} from "../../src/lib/discovery/scraper";
import type { TeacherLabel } from "./06_build_review_sheets";
import { evalDir, readCsv, readJson, readJsonl, writeCsvAtomic, writeJsonAtomic } from "./lib/io";
import { RunManifest } from "./lib/manifest";
import {
  assertNoLeakage,
  assignSplits,
  discoveryRow,
  v0Prior,
} from "./lib/tables";
import { loadSnapshot, readVenueIndex } from "./lib/venue-index";

type CachedRoom = {
  capacity: number;
  evidence_quote?: string;
  reads?: Array<number | null>;
  features?: { grounded?: boolean } | null;
  extraction_failed?: boolean;
};

const LABEL_TOLERANCE = 0.1;

function quoteHas(quote: string, value: number): boolean {
  return new RegExp(`(?<!\\d)${value}(?!\\d)`).test(quote);
}

function representative(cluster: NumberHit[]): number {
  return (cluster.find((h) => h.regexHit) ?? cluster[0]).value;
}

function anyFlag(cluster: NumberHit[], key: keyof NumberHit): boolean {
  return cluster.some((h) => h[key] === true);
}

function main() {
  const manifest = new RunManifest("08b_candidate_tables");
  const index = readVenueIndex();
  const goldIds = new Set(readCsv(evalDir("gold_venues.csv")).map((g) => g.venue_id));
  const inData = index.filter((v) => v.in_dataset === "1");
  const splits = assignSplits(
    inData.map((v) => ({ venueId: v.venue_id, domain: v.domain, city: v.city })),
    goldIds,
  );
  const teacher = new Map(
    readJsonl<TeacherLabel>(evalDir("teacher_labels.jsonl")).map((t) => [t.venue_id, t]),
  );
  const google = new Map(readCsv(evalDir("google_features.csv")).map((g) => [g.venue_id, g]));

  const candidateColumns = [
    "venue_id",
    "domain",
    "city",
    "bucket",
    "split",
    "label_source",
    "value",
    "y",
    "abs_rel_error",
    "is_largest_regex",
    "is_pipeline_winner",
    ...CANDIDATE_FEATURE_ORDER,
  ] as const;

  const candidateRows: Array<Record<string, string | number>> = [];
  let positiveVenues = 0;

  const discoveryRows: Array<Record<string, string | number | null>> = [];
  const fitRows: Array<Record<string, string | number>> = [];

  for (const venue of inData) {
    const snap = loadSnapshot(venue.venue_id);
    if (!snap) continue;
    const split = splits.get(venue.venue_id)!;
    const pages = snap.pages
      .filter((p) => p.kind !== "pdf")
      .map((p) => ({ text: p.text, privateDining: p.kind === "private_dining" }));
    const text = pages.map((p) => p.text).join(" ");
    const hasEvent =
      pages.some((p) => p.privateDining) ||
      snap.external_event_links.length > 0 ||
      PRIVATE_DINING_KEYWORDS.test(text);

    const features = discoveryRow(
      { name: venue.name, bucket: venue.bucket as Bucket },
      google.get(venue.venue_id),
      snap.external_event_links.length > 0,
    );
    const { has_external_event_link: leakedLabel, ...preFetch } = features;
    void leakedLabel;
    discoveryRows.push({
      venue_id: venue.venue_id,
      domain: venue.domain,
      city: venue.city,
      bucket: venue.bucket,
      split,
      label_source: "snapshot",
      y: hasEvent ? 1 : 0,
      ...preFetch,
      v0_prior: Number(
        v0Prior(
          { name: venue.name, bucket: venue.bucket as Bucket, website: venue.website },
          google.get(venue.venue_id),
        ).toFixed(6),
      ),
    });

    const label = teacher.get(venue.venue_id);
    if (label?.status === "labeled" && label.hosts_private_events === "yes") {
      const figures = label.rooms.flatMap((r) =>
        [r.seated_max, r.standing_max].filter((n): n is number => n != null && n > 0),
      );
      fitRows.push({
        venue_id: venue.venue_id,
        domain: venue.domain,
        city: venue.city,
        bucket: venue.bucket,
        split,
        fit_bucket: venue.bucket,
        max_room: figures.length ? Math.max(...figures) : "",
        published: figures.length ? 1 : 0,
      });
    }

    if (!label || label.status !== "labeled") continue;
    const figures = label.rooms.flatMap((r) =>
      [r.seated_max, r.standing_max].filter((n): n is number => n != null && n > 0),
    );
    const cachePath = evalDir(".cache", "student", `${venue.venue_id}.json`);
    const cached = existsSync(cachePath)
      ? readJson<{ rooms?: CachedRoom[] }>(cachePath)
      : { rooms: [] };
    const rooms = cached.rooms ?? [];
    const reads = rooms.flatMap((r) => r.reads ?? []).filter((n): n is number => n != null);
    const quotes = rooms
      .filter((r) => r.features?.grounded && r.evidence_quote)
      .map((r) => r.evidence_quote!);
    const modals = rooms
      .filter((r) => !r.extraction_failed)
      .map((r) => r.capacity)
      .filter((n) => n > 0);

    const clusters = clusterNumberHits(extractPageNumberCandidates(pages));
    if (clusters.length === 0) continue;
    const ranked = clusters
      .map((cluster) => ({ cluster, value: representative(cluster) }))
      .sort((a, b) => b.value - a.value);
    const regexValues = ranked.filter((c) => anyFlag(c.cluster, "regexHit")).map((c) => c.value);
    const largestRegex = regexValues.length ? Math.max(...regexValues) : null;
    let venuePositive = false;

    ranked.forEach((item, index) => {
      const matched = figures.filter((f) => withinRelative(item.value, f, LABEL_TOLERANCE));
      const y = matched.length ? 1 : 0;
      if (y === 1) venuePositive = true;
      const rel =
        figures.length === 0
          ? ""
          : Math.min(...figures.map((f) => Math.abs(item.value - f) / f)).toFixed(6);
      const encoded = encodeCandidateFeatures({
        llmVotes: reads.filter((n) => withinRelative(n, item.value, LABEL_TOLERANCE)).length,
        regexHit: anyFlag(item.cluster, "regexHit"),
        inGroundedQuote: quotes.some((q) => quoteHas(q, item.value)),
        roomWordNear: anyFlag(item.cluster, "roomWordNear"),
        capacityVerbNear: anyFlag(item.cluster, "capacityVerbNear"),
        reservationPhraseNear: anyFlag(item.cluster, "reservationPhraseNear"),
        wholeVenuePhraseNear: anyFlag(item.cluster, "wholeVenuePhraseNear"),
        looksLikeJunk: anyFlag(item.cluster, "looksLikeJunk"),
        onPrivatePage: anyFlag(item.cluster, "onPrivatePage"),
        valueRank: index + 1,
        logValue: Math.log(item.value),
        nCandidates: ranked.length,
      });
      candidateRows.push({
        venue_id: venue.venue_id,
        domain: venue.domain,
        city: venue.city,
        bucket: venue.bucket,
        split,
        label_source: goldIds.has(venue.venue_id) ? "teacher_human_confirmed" : "teacher",
        value: item.value,
        y,
        abs_rel_error: rel,
        is_largest_regex: largestRegex != null && item.value === largestRegex ? 1 : 0,
        is_pipeline_winner: modals.some((n) => withinRelative(n, item.value, LABEL_TOLERANCE)) ? 1 : 0,
        ...encoded,
      });
    });
    if (venuePositive) positiveVenues += 1;
  }

  const bySplit = (rows: Array<Record<string, string | number | null>>) => {
    const train = rows.filter((r) => r.split === "train");
    const test = rows.filter((r) => r.split !== "train");
    assertNoLeakage(
      train.map((r) => ({
        venue_id: String(r.venue_id),
        domain: String(r.domain),
        city: String(r.city),
      })),
      test.map((r) => ({ domain: String(r.domain) })),
      goldIds,
    );
    return { train, test };
  };

  const candidates = bySplit(candidateRows);
  const discovery = bySplit(discoveryRows);
  const fit = bySplit(fitRows);

  writeCsvAtomic(evalDir("train_candidates.csv"), candidateColumns, candidates.train);
  writeCsvAtomic(evalDir("test_candidates.csv"), candidateColumns, candidates.test);
  const discoveryColumns = Object.keys(discoveryRows[0] ?? { venue_id: "" });
  writeCsvAtomic(evalDir("train_discovery_event.csv"), discoveryColumns, discovery.train);
  writeCsvAtomic(evalDir("test_discovery_event.csv"), discoveryColumns, discovery.test);
  writeCsvAtomic(
    evalDir("fit_prior_hosts.csv"),
    ["venue_id", "domain", "city", "bucket", "split", "fit_bucket", "max_room", "published"],
    fitRows,
  );

  const trainCandidates = candidates.train as Array<Record<string, string | number>>;
  const trainPos = trainCandidates.filter((r) => r.y === 1);
  const summary = {
    candidate_rows: { train: candidates.train.length, test: candidates.test.length },
    candidate_positives: {
      train: trainPos.length,
      train_venues: new Set(trainPos.map((r) => r.venue_id)).size,
      all_positive_venues: positiveVenues,
    },
    discovery_event: {
      train: discovery.train.length,
      test: discovery.test.length,
      train_positives: discovery.train.filter((r) => r.y === 1).length,
    },
    fit_hosts_yes: {
      train: fit.train.length,
      train_published: fit.train.filter((r) => r.published === 1).length,
    },
  };
  writeJsonAtomic(evalDir("results", "candidate_tables.json"), summary);
  manifest.counts = {
    candidate_train: candidates.train.length,
    candidate_test: candidates.test.length,
    candidate_train_positives: trainPos.length,
    candidate_train_positive_venues: summary.candidate_positives.train_venues,
    discovery_event_train: discovery.train.length,
    fit_hosts_train: fit.train.length,
  };
  manifest.write();
  console.log(JSON.stringify(summary, null, 2));
}

main();
