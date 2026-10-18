import { describe, expect, it } from "vitest";
import {
  correctness,
  labelValue,
  matchOneToOne,
  matchRoom,
  type ExtractedRoom,
  type LabelRoom,
} from "./matching";

const label = (
  roomName: string,
  seatedMax: number | null,
  standingMax: number | null = null,
): LabelRoom => ({
  roomName,
  seatedMax,
  standingMax,
  min: null,
});
const ex = (
  roomName: string,
  capacity: number,
  style: ExtractedRoom["style"] = "unspecified",
): ExtractedRoom => ({
  roomKey: roomName,
  roomName,
  style,
  capacity,
});

describe("labelValue", () => {
  const loft = label("Loft", 50, 80);
  it("compares like with like", () => {
    expect(labelValue(loft, "seated", null)).toBe(50);
    expect(labelValue(loft, "standing", null)).toBe(80);
    expect(labelValue(loft, "unspecified", null)).toBe(50);
    expect(labelValue(label("Loft", null, 80), "unspecified", null)).toBe(80);
  });

  it("uses total seats for a buyout with no room figure", () => {
    expect(labelValue(label("Full buyout", null), "unspecified", 180)).toBe(
      180,
    );
    expect(labelValue(label("Patio", null), "unspecified", 180)).toBeNull();
  });
});

describe("matchRoom", () => {
  const labels = [
    label("Garden Room", 40),
    label("Library", 20),
    label("Wine Cellar", 12),
  ];

  it("matches by normalized name first, even when the capacity is far off", () => {
    expect(matchRoom(ex("The Garden Room", 90), labels, null)).toMatchObject({
      by: "name",
      value: 40,
    });
  });

  it("falls back to the nearest capacity within ±25%", () => {
    expect(matchRoom(ex("Upstairs", 24), labels, null)).toMatchObject({
      by: "nearest",
      value: 20,
    });
  });

  it("includes the ±25% boundary and excludes beyond it", () => {
    expect(
      matchRoom(ex("Upstairs", 50), [label("Garden Room", 40)], null),
    ).toMatchObject({ value: 40 });
    expect(
      matchRoom(ex("Upstairs", 51), [label("Garden Room", 40)], null),
    ).toBeNull();
  });

  it("breaks nearest-capacity ties by label order", () => {
    expect(
      matchRoom(ex("Upstairs", 30), [label("A", 25), label("B", 35)], null),
    ).toMatchObject({ label: { roomName: "A" } });
  });

  it("only compares a standing figure with standing figures", () => {
    expect(
      matchRoom(ex("Loft", 80, "standing"), [label("Loft", 80, null)], null),
    ).toBeNull();
    expect(
      matchRoom(ex("Loft", 80, "standing"), [label("Loft", 50, 80)], null),
    ).toMatchObject({ value: 80 });
  });
});

describe("correctness", () => {
  const m = (value: number) => ({
    label: label("x", value),
    value,
    field: "seated" as const,
    by: "name" as const,
  });

  it("counts exactly 10% as correct", () => {
    expect(correctness(44, m(40))).toEqual({ y: 1, absRelError: 0.1 });
    expect(correctness(36, m(40)).y).toBe(1);
  });

  it("counts just over 10% as wrong", () => {
    expect(correctness(45, m(40)).y).toBe(0);
    expect(correctness(35, m(40)).y).toBe(0);
  });

  it("labels an unmatched (invented) room 0", () => {
    expect(correctness(40, null)).toEqual({ y: 0, absRelError: null });
  });
});

describe("matchOneToOne", () => {
  it("uses each label figure once, preferring name matches", () => {
    const result = matchOneToOne(
      [ex("Room", 40), ex("Garden Room", 41)],
      [label("Garden Room", 40)],
      null,
    );
    expect(
      result.find((r) => r.room.roomName === "Garden Room")?.match,
    ).not.toBeNull();
    expect(result.find((r) => r.room.roomName === "Room")?.match).toBeNull();
  });
});
