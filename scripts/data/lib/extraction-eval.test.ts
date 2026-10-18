import { describe, expect, it } from "vitest";
import { scoreExtraction } from "./extraction-eval";

const gold = [
  { roomName: "Garden Room", seatedMax: 40, standingMax: 60, min: null },
  { roomName: "Library", seatedMax: 20, standingMax: null, min: null },
];
const ex = (roomName: string, capacity: number, style: "seated" | "standing" | "unspecified" = "seated") => ({
  roomKey: roomName,
  roomName,
  style,
  capacity,
});

describe("scoreExtraction", () => {
  it("scores precision, recall, accuracy and invented numbers per figure", () => {
    const s = scoreExtraction([
      { predicted: [ex("Garden Room", 42), ex("Library", 30), ex("Rooftop", 300)], gold, totalSeats: null },
    ]);
    expect(s).toMatchObject({ predicted: 3, gold_figures: 3, matched: 2, correct: 1 });
    expect(s.precision).toBeCloseTo(1 / 3);
    expect(s.recall).toBeCloseTo(1 / 3);
    expect(s.accuracy_within_10pct).toBeCloseTo(0.5);
    expect(s.invented_rate).toBeCloseTo(1 / 3);
  });

  it("returns nulls rather than dividing by zero", () => {
    const s = scoreExtraction([{ predicted: [], gold: [], totalSeats: null }]);
    expect([s.precision, s.recall, s.f1, s.invented_rate]).toEqual([null, null, null, null]);
  });
});
