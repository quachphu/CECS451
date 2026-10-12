import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extractPrivateDiningWithLlm } from "@/lib/discovery/llm-extract";

const PAGE = "The Garden Room holds 40 guests for private dinners.";
const okBody = {
  choices: [
    {
      message: {
        content: JSON.stringify({
          hostsPrivateEvents: true,
          rooms: [{ roomName: "Garden Room", maxCapacity: 40, minCapacity: null, evidenceQuote: PAGE }],
          minSpendUsd: null,
          minSpendEvidence: null,
          dietaryNotes: null,
        }),
      },
    },
  ],
};

describe("xAI retry policy", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubEnv("XAI_API_KEY", "test-key");
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("retries once after 1 s on 429, then succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("slow down", { status: 429 }))
      .mockResolvedValueOnce(Response.json(okBody));
    vi.stubGlobal("fetch", fetchMock);

    const pending = extractPrivateDiningWithLlm("Garden", PAGE, PAGE);
    await vi.advanceTimersByTimeAsync(999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result?.rooms[0]).toMatchObject({ roomName: "Garden Room", maxCapacity: 40 });
  });

  it("gives up with null after a second 5xx", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response("down", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);

    const pending = extractPrivateDiningWithLlm("Garden", PAGE, PAGE);
    await vi.runAllTimersAsync();

    expect(await pending).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry a 4xx other than 429", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response("bad", { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);

    const pending = extractPrivateDiningWithLlm("Garden", PAGE, PAGE);
    await vi.runAllTimersAsync();

    expect(await pending).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
