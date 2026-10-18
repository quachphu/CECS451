import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getCommuteMatrix } from "@/lib/geo/commute";

const origin = { lat: 40.758, lng: -73.9855 };
const venues = [
  { lat: 40.7592, lng: -73.9853 },
  { lat: 40.7544, lng: -73.9858 },
];

describe("getCommuteMatrix", () => {
  beforeEach(() => {
    vi.stubEnv("ORS_API_KEY", "test-key");
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("falls back to labelled estimates when OpenRouteService stalls, instead of hanging the search", async () => {
    vi.useFakeTimers();
    // A connection that never answers, but honours abort like real fetch.
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))))
      )
    );

    const pending = getCommuteMatrix(origin, venues, "walk");
    await vi.advanceTimersByTimeAsync(8_000);
    const results = await pending;

    expect(results).toHaveLength(2);
    expect(results.every((r) => r.estimated)).toBe(true);
  });

  it("uses the routed times when OpenRouteService answers", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              durations: [[120, 300]],
              distances: [[160, 420]],
            }),
            { status: 200 }
          )
      )
    );

    const results = await getCommuteMatrix(origin, venues, "walk");

    expect(results).toEqual([
      { distanceMeters: 160, durationSeconds: 120, estimated: false },
      { distanceMeters: 420, durationSeconds: 300, estimated: false },
    ]);
  });
});
