import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enrichCandidates, MAX_LLM_BUDGET, MAX_RENDER_BUDGET, type EnrichmentDeps } from "@/lib/discovery/pipeline";
import type { CandidateVenue } from "@/lib/discovery/places";
import type { ScrapedSignals } from "@/lib/discovery/scraper";
import { buildVenueDraft } from "@/lib/discovery/trust";

const SCRAPE_MS = 1_000;
const RENDER_MS = 6_000;
const LLM_MS = 7_000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function candidate(i: number): CandidateVenue {
  return {
    placeSourceId: `osm-${i}`,
    name: `Venue ${i}`,
    formattedAddress: `${i} Test St`,
    lat: 40.75,
    lng: -73.98,
    category: "restaurant",
    website: `https://venue${i}.example/`,
  };
}

/** A private-dining page with no static capacity figure: wants a render and an LLM read. */
function pdNoCapacity(website: string): ScrapedSignals {
  const text = "Private events. Our upstairs room hosts parties of thirty.";
  return {
    privateDiningPageFound: true,
    scrapedUrls: [website],
    capacityNumbers: [],
    capacityCandidates: [],
    minSpendUsd: [],
    email: null,
    phone: null,
    descriptionExcerpt: null,
    menuUrl: null,
    dietaryNotes: null,
    renderedWithJs: false,
    combinedText: text,
    privateDiningText: text,
    renderTarget: website,
    pages: [{ url: `${website}private`, text, privateDining: true }],
    links: [],
  };
}

function timedDeps(
  scrapeStarts: number[] = []
): EnrichmentDeps & { renderCalls: () => number; llmCalls: () => number } {
  let renders = 0;
  let llms = 0;
  return {
    scrape: async (website) => {
      scrapeStarts.push(Date.now());
      await sleep(SCRAPE_MS);
      return pdNoCapacity(website);
    },
    render: async () => {
      renders += 1;
      await sleep(RENDER_MS);
      return null; // rendering found nothing new
    },
    extract: async () => {
      llms += 1;
      await sleep(LLM_MS);
      return null;
    },
    isLlmConfigured: () => true,
    renderCalls: () => renders,
    llmCalls: () => llms,
  };
}

/**
 * The pre-Step-2 design, reproduced for comparison: 8 workers, each doing
 * scrape → render (no budget) → LLM inline (budget 8, only when the regex found
 * nothing) before taking the next candidate.
 */
async function oldInlineDesign(candidates: CandidateVenue[], deps: EnrichmentDeps): Promise<void> {
  let cursor = 0;
  let llmSpent = 0;
  async function worker() {
    while (cursor < candidates.length) {
      const c = candidates[cursor++];
      const signals = await deps.scrape(c.website!);
      if (signals.capacityNumbers.length === 0) await deps.render(signals.renderTarget!);
      if (signals.capacityNumbers.length === 0 && signals.privateDiningPageFound && llmSpent < 8) {
        llmSpent += 1;
        await deps.extract(c.name, signals.combinedText, "");
      }
      buildVenueDraft(c, signals);
    }
  }
  await Promise.all(Array.from({ length: 8 }, worker));
}

async function timeIt(run: () => Promise<unknown>): Promise<number> {
  const start = Date.now();
  const done = run();
  await vi.runAllTimersAsync();
  await done;
  return Date.now() - start;
}

describe("pipelined enrichment (fake timers)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("never lets an LLM call occupy a scrape slot", async () => {
    const scrapeStarts: number[] = [];
    const deps = timedDeps(scrapeStarts);
    // Long LLM calls: if they ran inside scrape workers, the 9th scrape could
    // not start until a worker finished scrape + render + LLM.
    deps.extract = async () => {
      await sleep(60_000);
      return null;
    };
    deps.render = async () => null;

    const t0 = Date.now();
    const run = enrichCandidates(
      Array.from({ length: 9 }, (_, i) => candidate(i)),
      deps
    );
    await vi.runAllTimersAsync();
    await run;

    expect(scrapeStarts).toHaveLength(9);
    expect(scrapeStarts[8] - t0).toBe(SCRAPE_MS);
  });

  it(`performance guard: 45 candidates — no slower than the old inline design; renders ≤ ${MAX_RENDER_BUDGET}, LLM ≤ ${MAX_LLM_BUDGET}`, async () => {
    const candidates = Array.from({ length: 45 }, (_, i) => candidate(i));

    const newDeps = timedDeps();
    const newMs = await timeIt(() => enrichCandidates(candidates, newDeps));

    const oldDeps = timedDeps();
    const oldMs = await timeIt(() => oldInlineDesign(candidates, oldDeps));

    expect(newDeps.renderCalls()).toBeLessThanOrEqual(MAX_RENDER_BUDGET);
    expect(newDeps.llmCalls()).toBeLessThanOrEqual(MAX_LLM_BUDGET);
    expect(newMs).toBeLessThanOrEqual(oldMs);
    // Recorded in NOTES-ai-core.md: old 45 renders, new 10.
    expect(oldDeps.renderCalls()).toBe(45);
  });
});
