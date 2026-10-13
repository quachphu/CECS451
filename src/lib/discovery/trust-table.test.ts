import { afterEach, describe, expect, it, vi } from "vitest";
import { buildVenueDraft } from "@/lib/discovery/trust";
import { groundExtraction, type LlmExtraction } from "@/lib/discovery/llm-extract";
import { scrapeVenueForPrivateDining, type CapacityCandidate, type ScrapedSignals } from "@/lib/discovery/scraper";
import type { CandidateVenue } from "@/lib/discovery/places";
import { GARDEN_SITE, gardenSiteFetch } from "@/lib/discovery/__fixtures__/garden-room-site";

const venue: CandidateVenue = {
  placeSourceId: "osm-7",
  name: "Garden Bistro",
  formattedAddress: "7 Test St",
  lat: 40.75,
  lng: -73.98,
  category: "restaurant",
  website: "https://example.com",
};

const PD_URL = "https://example.com/private-events";
const PD_TEXT = "The Garden Room holds 40 guests for private dinners. The Chef's Table seats 12 guests.";

function cand(value: number, roomHint: string | null, sentence: string): CapacityCandidate {
  return { value, roomHint, sentence, context: sentence, url: PD_URL, onPrivateDiningPage: true };
}

function signals(candidates: CapacityCandidate[], overrides: Partial<ScrapedSignals> = {}): ScrapedSignals {
  return {
    privateDiningPageFound: true,
    scrapedUrls: ["https://example.com", PD_URL],
    capacityNumbers: candidates.map((c) => c.value).sort((a, b) => a - b),
    capacityCandidates: candidates,
    minSpendUsd: [],
    email: null,
    phone: null,
    descriptionExcerpt: null,
    menuUrl: null,
    dietaryNotes: null,
    renderedWithJs: false,
    combinedText: `Home. \n ${PD_TEXT}`,
    privateDiningText: PD_TEXT,
    renderTarget: null,
    pages: [
      { url: "https://example.com", text: "Home.", privateDining: false },
      { url: PD_URL, text: PD_TEXT, privateDining: true },
    ],
    links: [],
    ...overrides,
  };
}

function llm(rooms: LlmExtraction["rooms"]): LlmExtraction {
  return { rooms, minSpendUsd: null, dietaryNotes: null, hostsPrivateEvents: true };
}

const GARDEN_SENTENCE = "The Garden Room holds 40 guests for private dinners.";

describe("Step 2f trust table", () => {
  it("regex + grounded LLM agree within 20% → verified, regex value, LLM quote as evidence", () => {
    const draft = buildVenueDraft(
      venue,
      signals([cand(40, "Garden Room", GARDEN_SENTENCE)]),
      llm([
        {
          roomName: "Garden Room",
          maxCapacity: 42,
          minCapacity: null,
          evidenceQuote: "The Garden Room holds 40 guests",
        },
      ])
    );

    expect(draft.rooms).toHaveLength(1);
    expect(draft.rooms[0]).toMatchObject({
      roomName: "Garden Room",
      maxCapacity: 40,
      capacityTrust: "verified",
      isEstimate: false,
      evidenceQuote: "The Garden Room holds 40 guests",
      evidenceUrl: PD_URL,
    });
  });

  it("grounded LLM room with no agreeing regex candidate → ai_extracted", () => {
    const draft = buildVenueDraft(
      venue,
      signals([cand(40, "Garden Room", GARDEN_SENTENCE)]),
      llm([
        { roomName: "Garden Room", maxCapacity: 40, minCapacity: null, evidenceQuote: GARDEN_SENTENCE },
        {
          roomName: "Chef's Table",
          maxCapacity: 12,
          minCapacity: null,
          evidenceQuote: "The Chef's Table seats 12 guests.",
        },
      ])
    );

    const chefs = draft.rooms.find((r) => r.roomName === "Chef's Table")!;
    expect(chefs.capacityTrust).toBe("ai_extracted");
    expect(chefs.maxCapacity).toBe(12);
    expect(chefs.evidenceUrl).toBe(PD_URL);
    expect(draft.rooms.find((r) => r.roomName === "Garden Room")!.capacityTrust).toBe("verified");
  });

  it("regex only, with a private-dining page → likely, uses the room-named candidate, never the max", () => {
    const draft = buildVenueDraft(
      venue,
      signals([cand(180, null, "Our main dining room seats 180 guests."), cand(40, "Garden Room", GARDEN_SENTENCE)])
    );

    expect(draft.rooms).toHaveLength(1);
    expect(draft.rooms[0]).toMatchObject({
      roomName: "Garden Room",
      maxCapacity: 40,
      capacityTrust: "likely",
      evidenceQuote: GARDEN_SENTENCE,
      evidenceUrl: PD_URL,
      isEstimate: false,
    });
    expect(draft.rooms[0].minCapacity).toBeUndefined();
  });

  it("regex only, no room names → the smallest plausible candidate", () => {
    const draft = buildVenueDraft(
      venue,
      signals([cand(180, null, "seats 180 guests"), cand(60, null, "up to 60 guests"), cand(25, null, "for 25 guests")])
    );

    expect(draft.rooms[0].maxCapacity).toBe(25);
    expect(draft.rooms[0].capacityTrust).toBe("likely");
  });

  it("regex and LLM disagree by more than 20% → likely, both figures in the note", () => {
    const draft = buildVenueDraft(
      venue,
      signals([cand(40, "Garden Room", GARDEN_SENTENCE)]),
      llm([
        {
          roomName: "Garden Room",
          maxCapacity: 90,
          minCapacity: null,
          evidenceQuote: "seats 90 guests in the Garden Room",
        },
      ])
    );

    expect(draft.rooms[0].capacityTrust).toBe("likely");
    expect(draft.rooms[0].maxCapacity).toBe(40);
    expect(draft.rooms[0].notes).toMatch(/sources disagree/i);
    expect(draft.rooms[0].notes).toContain("40");
    expect(draft.rooms[0].notes).toContain("90");
  });

  it("nothing found → category estimate flagged is_estimate", () => {
    const draft = buildVenueDraft(venue, signals([], { privateDiningPageFound: false }));

    expect(draft.rooms[0].isEstimate).toBe(true);
    expect(draft.rooms[0].capacityTrust).toBe("unverified");
    expect(draft.rooms[0].evidenceQuote).toBeNull();
  });

  it("no website → estimate flagged is_estimate", () => {
    expect(buildVenueDraft({ ...venue, website: undefined }, null).rooms[0].isEstimate).toBe(true);
  });
});

describe("grounding the LLM's answer", () => {
  it("drops rooms whose quote is not on the page, and counts them", () => {
    const grounded = groundExtraction(
      {
        hostsPrivateEvents: true,
        rooms: [
          { roomName: "Garden Room", maxCapacity: 40, minCapacity: null, evidenceQuote: GARDEN_SENTENCE },
          { roomName: "Rooftop", maxCapacity: 150, minCapacity: null, evidenceQuote: "Our rooftop hosts 150 guests." },
        ],
        minSpendUsd: 5000,
        minSpendEvidence: "Minimum spend is $5,000.",
        dietaryNotes: null,
      },
      PD_TEXT
    );

    expect(grounded.rooms.map((r) => r.roomName)).toEqual(["Garden Room"]);
    expect(grounded.rejectedCount).toBe(1);
    expect(grounded.minSpendUsd).toBeNull();
    expect(grounded.minSpendRejected).toBe(true);
  });
});

describe("the reproduced Garden Room defect", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("stores the Garden Room as 40 with evidence — not 180 / verified", async () => {
    vi.stubGlobal("fetch", vi.fn(gardenSiteFetch));
    const scraped = await scrapeVenueForPrivateDining(GARDEN_SITE);
    const draft = buildVenueDraft({ ...venue, website: GARDEN_SITE }, scraped);

    expect(draft.rooms).toHaveLength(1);
    expect(draft.rooms[0]).toMatchObject({ roomName: "Garden Room", maxCapacity: 40, capacityTrust: "likely" });
    expect(draft.rooms[0].minCapacity).toBeUndefined();
    expect(draft.rooms[0].evidenceQuote).toContain("Garden Room holds 40 guests");
    expect(draft.rooms[0].evidenceUrl).toBe("https://garden.example/private-events");
  });

  it("upgrades to verified when a grounded second read agrees", async () => {
    vi.stubGlobal("fetch", vi.fn(gardenSiteFetch));
    const scraped = await scrapeVenueForPrivateDining(GARDEN_SITE);
    const llmRead = groundExtraction(
      {
        hostsPrivateEvents: true,
        rooms: [
          {
            roomName: "The Garden Room",
            maxCapacity: 40,
            minCapacity: null,
            evidenceQuote: "The Garden Room holds 40 guests for private dinners.",
          },
        ],
        minSpendUsd: null,
        minSpendEvidence: null,
        dietaryNotes: null,
      },
      scraped.privateDiningText!
    );
    const draft = buildVenueDraft({ ...venue, website: GARDEN_SITE }, scraped, llmRead);

    expect(draft.rooms[0]).toMatchObject({ maxCapacity: 40, capacityTrust: "verified" });
  });
});

describe("review fixes: figures from the wrong page", () => {
  const HOME = "https://example.com";
  const home = (value: number, sentence: string): CapacityCandidate => ({
    value,
    roomHint: null,
    sentence,
    context: sentence,
    url: HOME,
    onPrivateDiningPage: false,
  });

  it("does not show a homepage figure for a private room the model read in prose (B)", () => {
    const draft = buildVenueDraft(
      venue,
      signals([home(180, "Our main dining room seats 180 guests.")]),
      llm([
        {
          roomName: "Garden Room",
          maxCapacity: 40,
          minCapacity: null,
          evidenceQuote: "garden room comfortably hosts forty guests",
        },
      ])
    );

    expect(draft.rooms[0]).toMatchObject({ roomName: "Garden Room", maxCapacity: 40, capacityTrust: "ai_extracted" });
    expect(draft.rooms[0].notes).not.toMatch(/disagree/i);
  });

  it("does not let a homepage figure that happens to be close 'verify' a private room (C)", () => {
    const draft = buildVenueDraft(
      venue,
      signals([home(45, "Our main dining room seats 45 guests.")]),
      llm([
        {
          roomName: "Garden Room",
          maxCapacity: 40,
          minCapacity: null,
          evidenceQuote: "The Garden Room holds 40 guests",
        },
      ])
    );

    expect(draft.rooms[0].capacityTrust).toBe("ai_extracted");
    expect(draft.rooms[0].maxCapacity).toBe(40);
  });

  it("still lets a homepage figure corroborate when the page names the same room", () => {
    const draft = buildVenueDraft(
      venue,
      signals([{ ...home(40, "The Garden Room holds 40 guests."), roomHint: "Garden Room" }]),
      llm([
        {
          roomName: "Garden Room",
          maxCapacity: 40,
          minCapacity: null,
          evidenceQuote: "The Garden Room holds 40 guests",
        },
      ])
    );

    expect(draft.rooms[0].capacityTrust).toBe("verified");
  });

  it("labels a regex-only homepage figure unverified even when a private-dining page exists (D)", () => {
    const draft = buildVenueDraft(venue, signals([home(180, "Our main dining room seats 180 guests.")]));

    expect(draft.rooms[0].capacityTrust).toBe("unverified");
    expect(draft.rooms[0].notes).toMatch(/not on a private-dining page/i);
  });
});

describe("review fix: model minimums are validated (E)", () => {
  it("drops a minCapacity above the maximum or not a positive integer", () => {
    const grounded = groundExtraction(
      {
        hostsPrivateEvents: true,
        rooms: [
          { roomName: "Garden Room", maxCapacity: 40, minCapacity: 400, evidenceQuote: GARDEN_SENTENCE },
          {
            roomName: "Chef's Table",
            maxCapacity: 12,
            minCapacity: 6,
            evidenceQuote: "The Chef's Table seats 12 guests.",
          },
        ],
        minSpendUsd: null,
        minSpendEvidence: null,
        dietaryNotes: null,
      },
      PD_TEXT
    );

    expect(grounded.rooms.map((r) => r.minCapacity)).toEqual([null, 6]);
  });
});
