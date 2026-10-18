/**
 * Step 3: save each venue's pages once, so every later step reads
 * eval/snapshots/ and never re-fetches a website.
 *
 *   npx tsx scripts/data/03_snapshot.ts --pilot     # 20 venues (5 per city) + PDF pilot  → STOP 1
 *   npx tsx scripts/data/03_snapshot.ts --full      # every venue in venues.csv
 *   npx tsx scripts/data/03_snapshot.ts --replace   # draw reserves for failed venues
 *   add --pdf to parse one event PDF per venue (only after approval at STOP 1)
 *
 * Honours robots.txt (RFC 9309), identifies as RESEARCH_USER_AGENT, sends at
 * most one request per second per host with eight hosts in parallel, and
 * falls back to Firecrawl (markdown, onlyMainContent, 1 credit) only for empty
 * or blocked pages [D1]. Firecrawl spend is capped at FIRECRAWL_CREDIT_CAP
 * (default 900) and PDF parsing at FIRECRAWL_PDF_CREDIT_CAP (default 150).
 */
import { existsSync } from "node:fs";
import { Budget, BudgetExceededError } from "./lib/budget";
import "./lib/env";
import { createHostLimiter } from "./lib/host-limiter";
import { cliArgs, evalDir, readCsv, readJson, writeCsvAtomic, writeJsonAtomic } from "./lib/io";
import { RunManifest } from "./lib/manifest";
import { snapshotVenue, type Renderer, type Snapshot } from "./lib/snapshot-core";
import { buildVenueIndex } from "./lib/venue-index";

const FIRECRAWL = "https://api.firecrawl.dev/v2";
const PILOT_PER_CITY = 5;
const PILOT_MAX_PDFS = 5;
const MIN_OK_VENUES = 500;

type VenueRow = Record<string, string>;

function firecrawlKey(): string | null {
  return process.env.FIRECRAWL_API_KEY?.trim() || null;
}

/** Remaining team credits, used to measure what a run actually cost. */
async function remainingCredits(key: string): Promise<number | null> {
  try {
    const res = await fetch(`${FIRECRAWL}/team/credit-usage`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: { remainingCredits?: number; remaining_credits?: number } };
    return body.data?.remainingCredits ?? body.data?.remaining_credits ?? null;
  } catch {
    return null;
  }
}

function makeRenderer(key: string, pages: Budget, pdfs: Budget, pdfLog: Array<Record<string, unknown>>): Renderer {
  return async (url, mode) => {
    const budget = mode === "pdf" ? pdfs : pages;
    // A PDF can cost a credit per page; refuse when fewer than 10 credits remain.
    const worstCase = mode === "pdf" ? 10 : 1;
    budget.reserve(worstCase);
    if (mode === "pdf") pages.reserve(worstCase);
    const before = mode === "pdf" ? await remainingCredits(key) : null;
    // Only `markdown`, only the main content: never crawl, map, search, agent or JSON formats.
    const res = await fetch(`${FIRECRAWL}/scrape`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ url, formats: ["markdown"], onlyMainContent: true }),
      signal: AbortSignal.timeout(60_000),
    }).catch(() => null);
    const payload = res?.ok
      ? ((await res.json()) as {
          success?: boolean;
          data?: { markdown?: string; metadata?: { statusCode?: number; creditsUsed?: number; numPages?: number } };
        })
      : null;
    const after = mode === "pdf" ? await remainingCredits(key) : null;
    const measured = before != null && after != null ? before - after : null;
    const reported = payload?.data?.metadata?.creditsUsed;
    const credits =
      measured ?? reported ?? (res?.ok ? (mode === "pdf" ? 1 + (payload?.data?.metadata?.numPages ?? 1) : 1) : 0);
    budget.charge(credits);
    if (mode === "pdf") pages.charge(credits);
    const markdown = payload?.data?.markdown ?? "";
    const status = payload?.data?.metadata?.statusCode ?? null;
    if (mode === "pdf") {
      pdfLog.push({
        url,
        credits,
        credits_source: measured != null ? "measured" : reported != null ? "reported" : "estimated",
        pages: payload?.data?.metadata?.numPages ?? null,
        chars: markdown.length,
        sample: markdown.replace(/\s+/g, " ").slice(0, 300),
      });
    }
    if (!payload?.success || !markdown || (status != null && status >= 400)) return null;
    return { text: mode === "pdf" ? markdown : markdown.replace(/\s+/g, " ").trim(), status, credits };
  };
}

function pilotVenues(venues: VenueRow[]): VenueRow[] {
  const byCity = new Map<string, VenueRow[]>();
  for (const v of venues) byCity.set(v.city, [...(byCity.get(v.city) ?? []), v]);
  // Spread across buckets: one per bucket in turn until five are chosen.
  return Array.from(byCity.values()).flatMap((rows) => {
    const buckets = new Map<string, VenueRow[]>();
    for (const r of rows) buckets.set(r.bucket, [...(buckets.get(r.bucket) ?? []), r]);
    const picked: VenueRow[] = [];
    while (picked.length < Math.min(PILOT_PER_CITY, rows.length)) {
      for (const list of buckets.values())
        if (list.length && picked.length < PILOT_PER_CITY) picked.push(list.shift()!);
    }
    return picked;
  });
}

async function main() {
  const { flags, values } = cliArgs();
  const mode = flags.has("pilot") ? "pilot" : flags.has("full") ? "full" : flags.has("replace") ? "replace" : null;
  if (!mode) throw new Error("Choose --pilot, --full or --replace (see the header of this file).");
  const manifest = new RunManifest(`03_snapshot:${mode}`);
  const venuesFile = evalDir("venues.csv");
  if (!existsSync(venuesFile)) throw new Error(`${venuesFile} not found; run 01_sample_venues.ts first.`);
  const venues = readCsv(venuesFile);
  const reserve = readCsv(evalDir("venues_reserve.csv"));
  manifest.inputs.push(venuesFile);

  const key = firecrawlKey();
  const pages = new Budget("firecrawl", "credits", Number(process.env.FIRECRAWL_CREDIT_CAP ?? 900));
  const pdfs = new Budget("firecrawl_pdf", "credits", Number(process.env.FIRECRAWL_PDF_CREDIT_CAP ?? 150));
  const pdfLog: Array<Record<string, unknown>> = [];
  const render = key ? makeRenderer(key, pages, pdfs, pdfLog) : null;
  if (!key) console.warn("FIRECRAWL_API_KEY not set: empty or blocked pages will not be rendered.");
  const creditsBefore = key ? await remainingCredits(key) : null;

  const limiter = createHostLimiter(8, 1000);
  const snapPath = (id: string) => evalDir("snapshots", `${id}.json`);
  let pdfsLeft = mode === "pilot" ? PILOT_MAX_PDFS : flags.has("pdf") ? Infinity : 0;

  async function snap(v: VenueRow): Promise<Snapshot | null> {
    const file = snapPath(v.venue_id);
    if (existsSync(file)) {
      manifest.count("skipped_existing");
      return readJson<Snapshot>(file);
    }
    const host = (() => {
      try {
        return new URL(v.website).hostname;
      } catch {
        return v.venue_id;
      }
    })();
    return limiter.forHost(host, async (wait) => {
      const allowance = pdfsLeft > 0 ? 1 : 0;
      pdfsLeft -= allowance;
      const s = await snapshotVenue(
        { venue_id: v.venue_id, website: v.website || null },
        { fetchImpl: fetch, render, wait, pdfAllowance: allowance }
      );
      if (allowance && !s.pages.some((p) => p.kind === "pdf")) pdfsLeft += allowance;
      writeJsonAtomic(file, s);
      manifest.count(`outcome_${s.fetch_outcome}`);
      return s;
    });
  }

  let status: "ok" | "aborted_budget" = "ok";
  const limit = values.has("limit") ? Number(values.get("limit")) : Infinity;
  try {
    if (mode === "replace") {
      // For every venue that isn't ok, try reserves from the same city and bucket in order.
      const replacements = readCsv(evalDir("replacements.csv"));
      const used = new Set(replacements.map((r) => r.replacement_venue_id));
      const replaced = new Set(replacements.filter((r) => r.outcome === "ok").map((r) => r.original_venue_id));
      for (const v of venues) {
        const s = existsSync(snapPath(v.venue_id)) ? readJson<Snapshot>(snapPath(v.venue_id)) : null;
        if (!s || s.fetch_outcome === "ok" || replaced.has(v.venue_id)) continue;
        for (const r of reserve.filter((r) => r.city === v.city && r.bucket === v.bucket && !used.has(r.venue_id))) {
          used.add(r.venue_id);
          const rs = await snap(r);
          replacements.push({
            original_venue_id: v.venue_id,
            original_outcome: s.fetch_outcome,
            replacement_venue_id: r.venue_id,
            outcome: rs?.fetch_outcome ?? "",
          });
          if (rs?.fetch_outcome === "ok") break;
        }
      }
      writeCsvAtomic(
        evalDir("replacements.csv"),
        ["original_venue_id", "original_outcome", "replacement_venue_id", "outcome"],
        replacements
      );
      manifest.outputs.push(evalDir("replacements.csv"));
    } else {
      const targets = (mode === "pilot" ? pilotVenues(venues) : venues).slice(0, limit);
      await Promise.all(targets.map((v) => snap(v)));
    }
  } catch (err) {
    if (!(err instanceof BudgetExceededError)) throw err;
    status = "aborted_budget";
    console.error(`${err.message}. Progress is saved; rerun after raising the cap or stop here.`);
  }

  // Summary across all snapshots on disk.
  const all = [...venues, ...reserve]
    .map((v) => (existsSync(snapPath(v.venue_id)) ? readJson<Snapshot>(snapPath(v.venue_id)) : null))
    .filter((s): s is Snapshot => s != null);
  const outcomes: Record<string, number> = {};
  for (const s of all) outcomes[s.fetch_outcome] = (outcomes[s.fetch_outcome] ?? 0) + 1;
  const creditsAfter = key ? await remainingCredits(key) : null;
  const summary = {
    mode,
    snapshots: all.length,
    outcomes,
    ok: outcomes.ok ?? 0,
    target_ok: MIN_OK_VENUES,
    non_english: all.filter((s) => s.language === "non_en").map((s) => s.venue_id),
    firecrawl_credits_ledger: pages.spent,
    firecrawl_pdf_credits_ledger: pdfs.spent,
    firecrawl_credits_measured_this_run:
      creditsBefore != null && creditsAfter != null ? creditsBefore - creditsAfter : null,
    firecrawl_remaining_credits: creditsAfter,
    pdf_pilot: pdfLog,
  };
  writeJsonAtomic(evalDir("results", `snapshot_${mode}.json`), summary);
  if (mode === "pilot") {
    const pilot = all.filter((s) => pilotVenues(venues).some((v) => v.venue_id === s.venue_id));
    const credits = pilot.reduce((sum, s) => sum + s.credits_used, 0);
    const pdfCredits = pdfLog.reduce((sum, p) => sum + Number(p.credits), 0);
    const pageCredits = credits - pdfCredits;
    writeJsonAtomic(evalDir("results", "snapshot_pilot_forecast.json"), {
      pilot_venues: pilot.length,
      page_credits: pageCredits,
      forecast_page_credits_for_560: pilot.length ? Math.round((pageCredits / pilot.length) * 560) : null,
      pdf_credits: pdfCredits,
      sample_snapshots: pilot
        .filter((s) => s.fetch_outcome === "ok")
        .slice(0, 3)
        .map((s) => snapPath(s.venue_id)),
    });
  }
  buildVenueIndex();
  manifest.outputs.push(evalDir("venue_index.csv"));
  manifest.spend.firecrawl_credits = pages.spent;
  manifest.spend.firecrawl_pdf_credits = pdfs.spent;
  manifest.models.user_agent = "private-dining-finder/0.2 (CSULB CECS 451 research)";
  manifest.write(status);
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
