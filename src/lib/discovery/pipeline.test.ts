import { describe, expect, it, vi } from "vitest";
import { enrichCandidates, MAX_RENDER_BUDGET, type EnrichmentDeps } from "@/lib/discovery/pipeline";
import type { CandidateVenue } from "@/lib/discovery/places";
import type { ScrapedSignals } from "@/lib/discovery/scraper";

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

/** Static pass that never finds a capacity figure, so every candidate wants a render. */
function staticMiss(website: string): ScrapedSignals {
  return {
    privateDiningPageFound: false,
    scrapedUrls: [website],
    capacityNumbers: [],
    minSpendUsd: [],
    email: null,
    phone: null,
    descriptionExcerpt: null,
    menuUrl: null,
    dietaryNotes: null,
    renderedWithJs: false,
    combinedText: "Welcome.",
    privateDiningText: "",
    renderTarget: website,
    pages: [{ url: website, text: "Welcome.", privateDining: false }],
    links: [],
  };
}

describe("render budget", () => {
  it(`never renders more than ${MAX_RENDER_BUDGET} pages per run, across concurrent workers`, async () => {
    const render = vi.fn(async (url: string) => ({ url, text: "Rendered page.", links: [] }));
    const deps: EnrichmentDeps = {
      scrape: async (website) => staticMiss(website),
      render,
      extract: vi.fn(async () => null),
      isLlmConfigured: () => false,
    };

    const { drafts, stats } = await enrichCandidates(Array.from({ length: 20 }, (_, i) => candidate(i)), deps);

    expect(render).toHaveBeenCalledTimes(MAX_RENDER_BUDGET);
    expect(stats.renders).toBe(MAX_RENDER_BUDGET);
    // Candidates past the budget are still drafted, just without a render.
    expect(drafts).toHaveLength(20);
    expect(drafts.filter((d) => d.sourceNote.includes("JavaScript"))).toHaveLength(MAX_RENDER_BUDGET);
  });
});
