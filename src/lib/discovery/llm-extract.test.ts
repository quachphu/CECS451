import { afterEach, describe, expect, it, vi } from "vitest";
import { buildLlmInput, extractPrivateDiningWithLlm } from "@/lib/discovery/llm-extract";
import { CHUNK_SEPARATOR } from "@/lib/discovery/scraper";

const HOME = "Welcome home page text.";
const PRIVATE = "The Garden Room holds 40 guests.";

describe("buildLlmInput", () => {
  it("puts the private-dining text first and does not repeat it", () => {
    const input = buildLlmInput(PRIVATE, [HOME, PRIVATE].join(CHUNK_SEPARATOR));

    expect(input).toBe(`${PRIVATE}${CHUNK_SEPARATOR}${HOME}`);
  });

  it("falls back to combinedText when no private-dining text exists", () => {
    expect(buildLlmInput("", HOME)).toBe(HOME);
  });

  it("truncates to the limit after reordering", () => {
    const input = buildLlmInput(PRIVATE, ["x".repeat(50), PRIVATE].join(CHUNK_SEPARATOR), 20);

    expect(input).toBe(PRIVATE.slice(0, 20));
  });
});

describe("extractPrivateDiningWithLlm request", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("sends the private-dining page at the start of the page text", async () => {
    vi.stubEnv("XAI_API_KEY", "test-key");
    const fetchMock = vi.fn<(url: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () =>
      Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify({ hostsPrivateEvents: true, rooms: [], minSpendUsd: null, dietaryNotes: null }),
            },
          },
        ],
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    await extractPrivateDiningWithLlm("Garden Bistro", [HOME, PRIVATE].join(CHUNK_SEPARATOR), PRIVATE);

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    const userContent: string = body.messages[1].content;
    expect(userContent.startsWith(`Venue: Garden Bistro\n\nPage text:\n${PRIVATE}`)).toBe(true);
    expect(body.model).toBe("grok-4.5");
    expect(body.temperature).toBe(0);
  });
});
