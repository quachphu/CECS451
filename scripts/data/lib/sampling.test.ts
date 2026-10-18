import { describe, expect, it } from "vitest";
import {
  BUCKETS,
  type Bucket,
} from "../../../src/lib/discovery/category-buckets";
import { seededRandom } from "./io";
import { allocate, cityOf, drawStratum, venueId } from "./sampling";

const avail = (counts: Partial<Record<Bucket, number>>) =>
  Object.fromEntries(BUCKETS.map((b) => [b, counts[b] ?? 0])) as Record<
    Bucket,
    number
  >;
const sum = (r: Record<Bucket, number>) =>
  BUCKETS.reduce((s, b) => s + r[b], 0);

describe("allocate", () => {
  it("hits the target, gives every bucket the minimum and splits the rest by availability", () => {
    const a = allocate(
      avail({
        casual_restaurant: 400,
        bar_lounge: 200,
        hotel: 60,
        event_space: 20,
        fine_dining: 30,
        steakhouse_grill: 25,
        fast_casual_cafe: 300,
      }),
      145,
    );
    expect(sum(a)).toBe(145);
    for (const b of BUCKETS) expect(a[b]).toBeGreaterThanOrEqual(8);
    expect(a.casual_restaurant).toBeGreaterThan(a.hotel);
  });

  it("takes everything from a bucket with fewer than the minimum", () => {
    const a = allocate(avail({ casual_restaurant: 400, event_space: 3 }), 100);
    expect(a.event_space).toBe(3);
    expect(sum(a)).toBe(100);
  });

  it("never allocates more than is available", () => {
    const a = allocate(avail({ casual_restaurant: 50, hotel: 10 }), 145);
    expect(a).toEqual(avail({ casual_restaurant: 50, hotel: 10 }));
  });
});

describe("drawStratum", () => {
  const pool = Array.from({ length: 30 }, (_, i) => ({
    key: `fsq-${i}`,
    bucket: "hotel" as const,
  }));

  it("is reproducible from the seed and independent of input order", () => {
    const a = drawStratum(pool, 10, seededRandom(451));
    const b = drawStratum([...pool].reverse(), 10, seededRandom(451));
    expect(a.sample.map((c) => c.key)).toEqual(b.sample.map((c) => c.key));
  });

  it("draws a 15% reserve disjoint from the sample", () => {
    const { sample, reserve } = drawStratum(pool, 10, seededRandom(451));
    expect(reserve).toHaveLength(2);
    expect(reserve.some((r) => sample.includes(r))).toBe(false);
  });
});

describe("cityOf / venueId", () => {
  it("places coordinates in the right city box", () => {
    expect(cityOf(40.758, -73.9855)).toBe("nyc");
    expect(cityOf(37.7898, -122.3969)).toBe("sf");
    expect(cityOf(21.2832, -157.8357)).toBe("hnl");
    expect(cityOf(34.0195, -118.4912)).toBe("la");
    expect(cityOf(0, 0)).toBeNull();
  });

  it("pads ids", () => {
    expect(venueId("nyc", 1)).toBe("nyc-0001");
  });
});
