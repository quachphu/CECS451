/**
 * Step 1: sample 560 venues from Foursquare OS Places [D-FSQ].
 *
 *   npx tsx scripts/data/01_sample_venues.ts
 *
 * Reads the Foursquare parquet files with DuckDB, keeps open venues with a
 * website of their own in the four city boxes, maps each to one bucket,
 * de-duplicates by website domain, and draws a stratified sample (city ×
 * bucket) plus a 15% reserve. Writes eval/venues.csv and eval/venues_reserve.csv.
 *
 * Source: FSQ_PARQUET (a path or glob, local or hf://), else the latest
 * release on Hugging Face (needs HF_TOKEN and the dataset terms accepted).
 */
import { DuckDBInstance } from "@duckdb/node-api";
import {
  BUCKETS,
  bucketFromFsqLabels,
  type Bucket,
} from "../../src/lib/discovery/category-buckets";
import {
  isSocialOnlyWebsite,
  normalizeWebsite,
  registeredDomain,
} from "../../src/lib/discovery/web-links";
import "./lib/env";
import {
  cliArgs,
  evalDir,
  seededRandom,
  writeCsvAtomic,
  writeJsonAtomic,
} from "./lib/io";
import { RunManifest } from "./lib/manifest";
import {
  allocate,
  CITY_BOXES,
  CITY_CODES,
  CITY_TARGETS,
  cityOf,
  drawStratum,
  MIN_PER_BUCKET,
  venueId,
  type CityCode,
} from "./lib/sampling";

export const VENUE_COLUMNS = [
  "venue_id",
  "fsq_place_id",
  "name",
  "address",
  "city",
  "lat",
  "lng",
  "website",
  "domain",
  "bucket",
  "fsq_categories",
] as const;

const HF_GLOB =
  "hf://datasets/foursquare/fsq-os-places/release/dt=*/places/parquet/*.parquet";
const CATEGORY_PREFILTER = [
  "Dining and Drinking",
  "Nightlife",
  "Lodging",
  "Hotel",
  "Event",
  "Banquet",
  "Bar",
];

type FsqRow = {
  fsq_place_id: string;
  name: string;
  latitude: number;
  longitude: number;
  address: string | null;
  locality: string | null;
  region: string | null;
  postcode: string | null;
  website: string | null;
  labels: string[];
};

function sqlString(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

type Conn = Awaited<ReturnType<DuckDBInstance["connect"]>>;

async function addHfSecret(conn: Conn): Promise<void> {
  const token = process.env.HF_TOKEN?.trim();
  if (!token)
    throw new Error(
      "Set HF_TOKEN (and accept the dataset terms on Hugging Face), or FSQ_PARQUET.",
    );
  await conn.run(
    `CREATE OR REPLACE SECRET hf_token (TYPE huggingface, TOKEN ${sqlString(token)})`,
  );
}

/** FSQ_PARQUET / --source as given; otherwise the newest Hugging Face release. */
async function resolveSource(conn: Conn, explicit: string): Promise<string> {
  if (explicit) {
    if (explicit.startsWith("hf://")) await addHfSecret(conn);
    return explicit;
  }
  await addHfSecret(conn);
  // Each release is a dt=YYYY-MM-DD folder; use only the newest so venues aren't counted twice.
  const files = await conn.runAndReadAll(
    `SELECT file FROM glob(${sqlString(HF_GLOB)})`,
  );
  const releases = Array.from(
    new Set(
      files
        .getRowObjects()
        .map((r) => /dt=([0-9-]+)/.exec(String(r.file))?.[1])
        .filter(Boolean) as string[],
    ),
  ).sort();
  const latest = releases.at(-1);
  if (!latest) throw new Error(`No Foursquare release found at ${HF_GLOB}`);
  return HF_GLOB.replace("dt=*", `dt=${latest}`);
}

async function loadRows(conn: Conn, source: string): Promise<FsqRow[]> {
  const boxes = Object.values(CITY_BOXES)
    .flat()
    .map(
      (b) =>
        `(latitude BETWEEN ${b.s} AND ${b.n} AND longitude BETWEEN ${b.w} AND ${b.e})`,
    )
    .join(" OR ");
  const categories = CATEGORY_PREFILTER.map(
    (c) =>
      `array_to_string(fsq_category_labels, '|') ILIKE ${sqlString(`%${c}%`)}`,
  ).join(" OR ");

  const sql = `
    SELECT fsq_place_id, name, latitude, longitude, address, locality, region, postcode, website,
           fsq_category_labels AS labels
    FROM read_parquet(${sqlString(source)})
    WHERE date_closed IS NULL
      AND website IS NOT NULL AND trim(website) <> ''
      AND (${boxes})
      AND (${categories})`;
  const reader = await conn.runAndReadAll(sql);
  return reader.getRowObjectsJS().map((r) => ({
    fsq_place_id: String(r.fsq_place_id),
    name: String(r.name ?? ""),
    latitude: Number(r.latitude),
    longitude: Number(r.longitude),
    address: (r.address as string | null) ?? null,
    locality: (r.locality as string | null) ?? null,
    region: (r.region as string | null) ?? null,
    postcode: (r.postcode as string | null) ?? null,
    website: (r.website as string | null) ?? null,
    labels: Array.isArray(r.labels) ? (r.labels as unknown[]).map(String) : [],
  }));
}

async function main() {
  const { values } = cliArgs();
  const manifest = new RunManifest("01_sample_venues");
  const conn = await (await DuckDBInstance.create(":memory:")).connect();
  const source = await resolveSource(
    conn,
    values.get("source") ?? process.env.FSQ_PARQUET?.trim() ?? "",
  );
  manifest.models.source = source;
  const rows = await loadRows(conn, source);
  manifest.count("fsq_rows_in_boxes", rows.length);

  type Kept = FsqRow & {
    city: CityCode;
    bucket: Bucket;
    website: string;
    domain: string;
    key: string;
  };
  const unmapped = new Map<string, number>();
  const kept: Kept[] = [];
  for (const row of rows) {
    const city = cityOf(row.latitude, row.longitude);
    if (!city) continue;
    if (isSocialOnlyWebsite(row.website)) {
      manifest.count("dropped_social_only_website");
      continue;
    }
    const website = normalizeWebsite(row.website);
    const domain = registeredDomain(website);
    if (!website || !domain) {
      manifest.count("dropped_invalid_website");
      continue;
    }
    const bucket = bucketFromFsqLabels(row.labels);
    if (!bucket) {
      manifest.count("dropped_unmapped_category");
      const label = row.labels[0] ?? "(none)";
      unmapped.set(label, (unmapped.get(label) ?? 0) + 1);
      continue;
    }
    kept.push({ ...row, city, bucket, website, domain, key: row.fsq_place_id });
  }

  // One venue per registered domain: chains share a site, and the train/test
  // split is by domain. The lowest fsq_place_id wins, deterministically.
  const byDomain = new Map<string, Kept>();
  for (const v of [...kept].sort((a, b) =>
    a.fsq_place_id.localeCompare(b.fsq_place_id),
  )) {
    if (byDomain.has(v.domain)) manifest.count("dropped_duplicate_domain");
    else byDomain.set(v.domain, v);
  }
  const unique = Array.from(byDomain.values());
  manifest.count("eligible", unique.length);

  const rand = seededRandom();
  const sampleRows: Array<Record<string, unknown>> = [];
  const reserveRows: Array<Record<string, unknown>> = [];
  const report: Record<string, unknown> = {
    strata: {},
    shortfalls: [] as string[],
  };

  for (const city of Object.keys(CITY_TARGETS) as CityCode[]) {
    const inCity = unique.filter((v) => v.city === city);
    const available = Object.fromEntries(
      BUCKETS.map((b) => [b, inCity.filter((v) => v.bucket === b).length]),
    ) as Record<Bucket, number>;
    const plan = allocate(available, CITY_TARGETS[city]);
    const planned = BUCKETS.reduce((s, b) => s + plan[b], 0);
    if (planned < CITY_TARGETS[city]) {
      (report.shortfalls as string[]).push(
        `${CITY_CODES[city]}: ${planned} of ${CITY_TARGETS[city]} (only ${inCity.length} eligible venues)`,
      );
    }
    let seq = 1;
    let reserveSeq = 1;
    for (const bucket of BUCKETS) {
      const pool = inCity.filter((v) => v.bucket === bucket);
      const { sample, reserve } = drawStratum(pool, plan[bucket], rand);
      if (pool.length < MIN_PER_BUCKET) {
        (report.shortfalls as string[]).push(
          `${CITY_CODES[city]} / ${bucket}: only ${pool.length} eligible (minimum ${MIN_PER_BUCKET}); took all`,
        );
      }
      (report.strata as Record<string, unknown>)[`${city}/${bucket}`] = {
        available: pool.length,
        sampled: sample.length,
        reserve: reserve.length,
      };
      const toRow = (v: Kept, id: string) => ({
        venue_id: id,
        fsq_place_id: v.fsq_place_id,
        name: v.name,
        address: [v.address, v.locality, v.region, v.postcode]
          .filter(Boolean)
          .join(", "),
        city: CITY_CODES[city],
        lat: v.latitude,
        lng: v.longitude,
        website: v.website,
        domain: v.domain,
        bucket: v.bucket,
        fsq_categories: v.labels.join("|"),
      });
      for (const v of sample) sampleRows.push(toRow(v, venueId(city, seq++)));
      for (const v of reserve)
        reserveRows.push(
          toRow(v, `${city}-r${String(reserveSeq++).padStart(3, "0")}`),
        );
    }
  }

  report.top_unmapped_categories = Array.from(unmapped.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 25);

  const venuesFile = evalDir("venues.csv");
  const reserveFile = evalDir("venues_reserve.csv");
  writeCsvAtomic(venuesFile, VENUE_COLUMNS, sampleRows);
  writeCsvAtomic(reserveFile, VENUE_COLUMNS, reserveRows);
  writeJsonAtomic(evalDir("results", "sampling_report.json"), report);

  manifest.count("sampled", sampleRows.length);
  manifest.count("reserve", reserveRows.length);
  manifest.outputs.push(venuesFile, reserveFile);
  manifest.write();
  console.log(
    `Sampled ${sampleRows.length} venues (+${reserveRows.length} reserve).`,
  );
  for (const s of report.shortfalls as string[])
    console.log(`  shortfall: ${s}`);
  console.log(`  counts: ${JSON.stringify(manifest.counts)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
