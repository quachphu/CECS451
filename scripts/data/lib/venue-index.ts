/**
 * eval/venue_index.csv: every venue that entered the dataset — the original
 * sample plus reserves drawn as replacements — with its fetch outcome. Failed
 * venues stay listed for the data funnel; `in_dataset` marks the usable ones.
 */
import { existsSync } from "node:fs";
import { evalDir, readCsv, readJson, writeCsvAtomic } from "./io";
import type { Snapshot } from "./snapshot-core";

export const INDEX_COLUMNS = [
  "venue_id",
  "source",
  "replaces",
  "name",
  "address",
  "city",
  "bucket",
  "domain",
  "website",
  "fetch_outcome",
  "language",
  "in_dataset",
] as const;

export type IndexRow = Record<(typeof INDEX_COLUMNS)[number], string>;

export function snapshotPath(venueId: string): string {
  return evalDir("snapshots", `${venueId}.json`);
}

export function loadSnapshot(venueId: string): Snapshot | null {
  const file = snapshotPath(venueId);
  return existsSync(file) ? readJson<Snapshot>(file) : null;
}

export function buildVenueIndex(): IndexRow[] {
  const replacements = readCsv(evalDir("replacements.csv"));
  const replaces = new Map(
    replacements.map((r) => [r.replacement_venue_id, r.original_venue_id]),
  );
  const reserve = readCsv(evalDir("venues_reserve.csv")).filter((r) =>
    replaces.has(r.venue_id),
  );
  const rows = [
    ...readCsv(evalDir("venues.csv")).map((v) => ({ v, source: "sample" })),
    ...reserve.map((v) => ({ v, source: "reserve" })),
  ].map(({ v, source }) => {
    const snap = loadSnapshot(v.venue_id);
    return {
      venue_id: v.venue_id,
      source,
      replaces: replaces.get(v.venue_id) ?? "",
      name: v.name,
      address: v.address,
      city: v.city,
      bucket: v.bucket,
      domain: v.domain,
      website: v.website,
      fetch_outcome: snap?.fetch_outcome ?? "not_fetched",
      language: snap?.language ?? "",
      in_dataset: snap?.fetch_outcome === "ok" ? "1" : "0",
    };
  });
  writeCsvAtomic(evalDir("venue_index.csv"), INDEX_COLUMNS, rows);
  return rows;
}

export function readVenueIndex(): IndexRow[] {
  const rows = readCsv(evalDir("venue_index.csv")) as IndexRow[];
  if (rows.length === 0)
    throw new Error(
      `${evalDir("venue_index.csv")} is missing; run 03_snapshot.ts first.`,
    );
  return rows;
}
