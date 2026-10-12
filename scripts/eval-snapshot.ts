/**
 * Snapshots venue pages for offline evaluation (Step 9b).
 *
 * Reads eval/urls.csv (venue_key,url[,name,category,types,price_level]) and,
 * for each URL, runs only the static fetch and render paths — no LLM, no
 * database — honouring robots.txt exactly as the pipeline does. Writes
 * eval/snapshots/<venue_key>.json with the homepage text, the private-dining
 * text, any rendered text, every page read, and a timestamp; plus a row of
 * candidate metadata to eval/candidates.jsonl for refitting the discovery
 * prior. Snapshots are gitignored.
 *
 * Makes live requests (and spends Firecrawl credits when FIRECRAWL_API_KEY is
 * set). Run with: npx tsx scripts/eval-snapshot.ts [eval/urls.csv]
 */
import { config } from "dotenv";
config({ path: [".env.local", ".env"] });

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseCsv } from "../eval/csv";
import { createLimiter } from "@/lib/limiter";
import { isRenderFallbackConfigured, renderPage } from "@/lib/discovery/render";
import { createRobotsChecker } from "@/lib/discovery/robots";
import {
  applyRenderedPage,
  scrapeVenueForPrivateDining,
  type ScrapedPage,
  type ScrapedLink,
} from "@/lib/discovery/scraper";

export type Snapshot = {
  venueKey: string;
  url: string;
  fetchedAt: string;
  robotsBlocked: boolean;
  homepageText: string;
  privateDiningText: string;
  renderedText: string | null;
  pages: ScrapedPage[];
  links: ScrapedLink[];
};

const SNAPSHOT_DIR = join(process.cwd(), "eval", "snapshots");

async function main() {
  const urlsPath = process.argv[2] ?? "eval/urls.csv";
  const rows = parseCsv(readFileSync(urlsPath, "utf8"));
  mkdirSync(SNAPSHOT_DIR, { recursive: true });
  const robots = createRobotsChecker();
  const limit = createLimiter(4);
  const candidateRows: string[] = [];

  await Promise.all(
    rows.map((row) =>
      limit(async () => {
        let signals = await scrapeVenueForPrivateDining(row.url, { robots });
        let renderedText: string | null = null;
        if (signals.renderTarget && isRenderFallbackConfigured()) {
          const rendered = await renderPage(signals.renderTarget);
          if (rendered?.text) {
            renderedText = rendered.text;
            signals = applyRenderedPage(signals, rendered, row.url);
          }
        }

        const snapshot: Snapshot = {
          venueKey: row.venue_key,
          url: row.url,
          fetchedAt: new Date().toISOString(),
          robotsBlocked: Boolean(signals.robotsBlocked),
          homepageText: signals.pages?.[0]?.text ?? "",
          privateDiningText: signals.privateDiningText ?? "",
          renderedText,
          pages: signals.pages ?? [],
          links: signals.links ?? [],
        };
        writeFileSync(join(SNAPSHOT_DIR, `${row.venue_key}.json`), JSON.stringify(snapshot, null, 1));
        candidateRows.push(
          JSON.stringify({
            venue_key: row.venue_key,
            name: row.name || row.venue_key,
            category: row.category || "",
            types: row.types ? row.types.split("|") : [],
            priceLevelGoogle: row.price_level ? Number(row.price_level) : null,
            website: row.url,
          })
        );
        console.log(
          `${row.venue_key}: ${snapshot.robotsBlocked ? "robots.txt disallows — skipped" : `${snapshot.pages.length} page(s)${renderedText ? " + render" : ""}`}`
        );
      })
    )
  );

  writeFileSync(join(process.cwd(), "eval", "candidates.jsonl"), candidateRows.join("\n") + "\n");
  console.log(`\n${rows.length} snapshot(s) in eval/snapshots; robots.txt skipped hosts: ${robots.skippedHosts.size}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
