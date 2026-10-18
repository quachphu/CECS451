import { describe, expect, it } from "vitest";
import {
  canonicalRoomName,
  normalizeRoomKey,
  numberWordsToDigits,
  parseCapacityText,
  roomNameJaccard,
  splitLabelRoom,
  wordsToNumber,
} from "@/lib/discovery/room-normalize";

describe("wordsToNumber / numberWordsToDigits", () => {
  it.each([
    ["forty", 40],
    ["forty-five", 45],
    ["one hundred and twenty", 120],
    ["a hundred", 100],
    ["two thousand", 2000],
  ])("%s → %d", (words, n) => {
    expect(wordsToNumber(words)).toBe(n);
  });

  it("rewrites number words inside text and leaves other words alone", () => {
    expect(numberWordsToDigits("The room seats forty-five guests and a bar")).toBe(
      "The room seats 45 guests and a bar"
    );
  });
});

describe("parseCapacityText", () => {
  it.each([
    ["40", { min: null, max: 40 }],
    ["1,200", { min: null, max: 1200 }],
    ["30–40", { min: 30, max: 40 }],
    ["30-40 guests", { min: 30, max: 40 }],
    ["30 to 40", { min: 30, max: 40 }],
    ["up to 80", { min: null, max: 80 }],
    ["thirty to forty", { min: 30, max: 40 }],
  ])("%s", (text, parsed) => {
    expect(parseCapacityText(text)).toEqual(parsed);
  });

  it("is null when there is no number", () => {
    expect(parseCapacityText("ask us")).toBeNull();
    expect(parseCapacityText("")).toBeNull();
    expect(parseCapacityText(null)).toBeNull();
  });
});

describe("canonicalRoomName", () => {
  it("names every buyout phrasing 'Full buyout'", () => {
    for (const name of ["Full Buyout", "Entire restaurant", "Whole venue buy-out", "Exclusive use of the restaurant"]) {
      expect(canonicalRoomName(name)).toBe("Full buyout");
    }
  });

  it("writes combined rooms as A+B", () => {
    expect(canonicalRoomName("Garden Room & Library combined")).toBe("Garden Room+Library");
    expect(canonicalRoomName("Garden Room + Library")).toBe("Garden Room+Library");
  });

  it("leaves ordinary names alone", () => {
    expect(canonicalRoomName("  The   Wine Cellar ")).toBe("The Wine Cellar");
  });
});

describe("normalizeRoomKey / roomNameJaccard", () => {
  it("drops the/room/private and punctuation", () => {
    expect(normalizeRoomKey("The Private Garden Room")).toBe("garden");
    expect(normalizeRoomKey("Chef's Table")).toBe("chef s table");
  });

  it("scores token overlap", () => {
    expect(roomNameJaccard("The Garden Room", "Garden")).toBe(1);
    expect(roomNameJaccard("Wine Cellar", "Wine Room")).toBe(0.5);
    expect(roomNameJaccard("Library", "Garden")).toBe(0);
  });
});

describe("splitLabelRoom", () => {
  it("makes one row per stated style", () => {
    expect(splitLabelRoom({ roomName: "Loft", seatedMax: 50, standingMax: 80, min: 20 })).toEqual([
      { roomName: "Loft", style: "seated", max: 50, min: 20 },
      { roomName: "Loft", style: "standing", max: 80, min: 20 },
    ]);
  });

  it("drops figures that are not stated", () => {
    expect(splitLabelRoom({ roomName: "Loft", seatedMax: null, standingMax: 80 })).toHaveLength(1);
  });
});
