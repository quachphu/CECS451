import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_XAI_MODEL, SELF_CONSISTENCY_K, SELF_CONSISTENCY_TEMPERATURE } from "@/lib/discovery/extraction-config";
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
    expect(body.model).toBe(DEFAULT_XAI_MODEL);
    expect(body.temperature).toBe(SELF_CONSISTENCY_TEMPERATURE);
    expect(fetchMock).toHaveBeenCalledTimes(SELF_CONSISTENCY_K);
  });

  it("uses XAI_MODEL when set", async () => {
    vi.stubEnv("XAI_API_KEY", "test-key");
    vi.stubEnv("XAI_MODEL", "grok-test");
    const fetchMock = vi.fn<(url: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => answer([]));
    vi.stubGlobal("fetch", fetchMock);

    await extractPrivateDiningWithLlm("Garden Bistro", PRIVATE, PRIVATE);

    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).model).toBe("grok-test");
  });
});

type Room = {
  roomName: string;
  style?: string;
  maxCapacity: number;
  minCapacity: number | null;
  evidenceQuote: string;
};

function answer(rooms: Room[], usage = { prompt_tokens: 1000, completion_tokens: 200 }) {
  return Response.json({
    model: "grok-test",
    usage,
    choices: [
      {
        message: {
          content: JSON.stringify({
            hostsPrivateEvents: true,
            rooms,
            minSpendUsd: null,
            minSpendEvidence: null,
            dietaryNotes: null,
          }),
        },
      },
    ],
  });
}

const GARDEN: Room = {
  roomName: "Garden Room",
  style: "seated",
  maxCapacity: 40,
  minCapacity: null,
  evidenceQuote: PRIVATE,
};

describe("self-consistency reads", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("merges k agreeing reads into one grounded room with self-consistency 1", async () => {
    vi.stubEnv("XAI_API_KEY", "test-key");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => answer([GARDEN]))
    );

    const result = await extractPrivateDiningWithLlm("Garden Bistro", PRIVATE, PRIVATE);

    expect(result?.rooms).toEqual([
      expect.objectContaining({
        roomName: "Garden Room",
        maxCapacity: 40,
        style: "seated",
        selfConsistency: 1,
        reads: [40, 40, 40],
      }),
    ]);
    expect(result?.successfulReads).toBe(3);
    expect(result?.inputText).toBe(PRIVATE);
  });

  it("keeps an ungrounded room out of `rooms` but in `aggregatedRooms`", async () => {
    vi.stubEnv("XAI_API_KEY", "test-key");
    const invented: Room = {
      roomName: "Rooftop",
      maxCapacity: 200,
      minCapacity: null,
      evidenceQuote: "Our rooftop holds 200 guests.",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => answer([GARDEN, invented]))
    );

    const result = await extractPrivateDiningWithLlm("Garden Bistro", PRIVATE, PRIVATE);

    expect(result?.rooms.map((r) => r.roomName)).toEqual(["Garden Room"]);
    expect(result?.aggregatedRooms?.find((r) => r.roomName === "Rooftop")).toMatchObject({
      grounded: false,
      capacity: 200,
    });
    expect(result?.rejectedCount).toBe(1);
  });

  it("retries failed reads once when fewer than two succeed", async () => {
    vi.stubEnv("XAI_API_KEY", "test-key");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(answer([GARDEN]))
      .mockResolvedValueOnce(new Response("bad", { status: 400 }))
      .mockResolvedValueOnce(new Response("bad", { status: 400 }))
      .mockImplementation(async () => answer([GARDEN]));
    vi.stubGlobal("fetch", fetchMock);

    const result = await extractPrivateDiningWithLlm("Garden Bistro", PRIVATE, PRIVATE);

    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(result?.successfulReads).toBe(3);
  });

  it("reports token usage for every response", async () => {
    vi.stubEnv("XAI_API_KEY", "test-key");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => answer([GARDEN]))
    );
    const usage: Array<{ promptTokens: number; completionTokens: number }> = [];

    await extractPrivateDiningWithLlm("Garden Bistro", PRIVATE, PRIVATE, { onUsage: (u) => usage.push(u) });

    expect(usage).toHaveLength(3);
    expect(usage[0]).toMatchObject({ model: "grok-test", promptTokens: 1000, completionTokens: 200 });
  });
});
