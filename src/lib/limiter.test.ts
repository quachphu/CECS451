import { describe, expect, it } from "vitest";
import { createLimiter } from "@/lib/limiter";

describe("createLimiter", () => {
  it("never runs more than n tasks at once and runs them all", async () => {
    const limit = createLimiter(3);
    let active = 0;
    let peak = 0;
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        limit(async () => {
          active += 1;
          peak = Math.max(peak, active);
          await new Promise((r) => setTimeout(r, 1));
          active -= 1;
          return i;
        })
      )
    );

    expect(peak).toBe(3);
    expect(results).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("propagates rejections without stalling the queue", async () => {
    const limit = createLimiter(1);
    const failed = limit(() => Promise.reject(new Error("boom")));
    const after = limit(async () => "still runs");

    await expect(failed).rejects.toThrow("boom");
    await expect(after).resolves.toBe("still runs");
  });

  it("rejects a non-positive concurrency", () => {
    expect(() => createLimiter(0)).toThrow(TypeError);
  });
});
