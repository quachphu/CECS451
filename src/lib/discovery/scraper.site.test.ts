import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scrapeVenueForPrivateDining } from "@/lib/discovery/scraper";
import { buildLlmInput, MAX_TEXT_CHARS } from "@/lib/discovery/llm-extract";
import { GARDEN_PRIVATE_TEXT, GARDEN_SITE, gardenSiteFetch } from "@/lib/discovery/__fixtures__/garden-room-site";

describe("scraping the Garden Room site", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(gardenSiteFetch));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the private-dining page's own text separately", async () => {
    const signals = await scrapeVenueForPrivateDining(GARDEN_SITE);

    expect(signals.privateDiningPageFound).toBe(true);
    expect(signals.privateDiningText).toContain("Garden Room");
    expect(signals.privateDiningText).not.toContain("main dining room");
  });

  it("reproduces the cut-off: the private page starts past the LLM's input limit in combinedText", async () => {
    const signals = await scrapeVenueForPrivateDining(GARDEN_SITE);

    expect(signals.combinedText.indexOf("Garden Room")).toBeGreaterThan(MAX_TEXT_CHARS);
  });

  it("builds LLM input that starts with the private-page text", async () => {
    const signals = await scrapeVenueForPrivateDining(GARDEN_SITE);
    const input = buildLlmInput(signals.privateDiningText ?? "", signals.combinedText);

    expect(input.startsWith(signals.privateDiningText!)).toBe(true);
    expect(input).toContain(GARDEN_PRIVATE_TEXT);
    expect(input.length).toBeLessThanOrEqual(MAX_TEXT_CHARS);
  });

  it("asks for no render when the static pass already found a capacity figure", async () => {
    const signals = await scrapeVenueForPrivateDining(GARDEN_SITE);

    expect(signals.renderTarget).toBeNull();
  });

  it("points the render tier at the homepage when the site can't be fetched at all", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("blocked")))
    );
    const signals = await scrapeVenueForPrivateDining(GARDEN_SITE);

    expect(signals.scrapedUrls).toEqual([]);
    expect(signals.renderTarget).toBe(GARDEN_SITE);
  });
});
