import { describe, expect, it } from "vitest";
import {
  bucketForVenue,
  bucketFromFsqLabels,
  bucketFromGoogle,
  bucketFromText,
} from "@/lib/discovery/category-buckets";

describe("bucketFromText (Foursquare paths and app category labels)", () => {
  it.each([
    ["Dining and Drinking > Restaurant > Steakhouse", "steakhouse_grill"],
    ["Dining and Drinking > Bar > Cocktail Bar", "bar_lounge"],
    ["Dining and Drinking > Bar > Hotel Bar", "bar_lounge"],
    ["Travel and Transportation > Lodging > Hotel", "hotel"],
    ["Business and Professional Services > Event Space", "event_space"],
    ["Dining and Drinking > Cafe, Coffee, and Tea House > Coffee Shop", "fast_casual_cafe"],
    ["Dining and Drinking > Restaurant > Italian Restaurant", "casual_restaurant"],
    ["Dining and Drinking > Restaurant > Fine Dining Restaurant", "fine_dining"],
    ["Dining and Drinking > Bar > Bar and Grill", "steakhouse_grill"],
    ["Hotel event space", "event_space"],
    ["American tavern", "bar_lounge"],
    ["night club", "bar_lounge"],
    ["Greek restaurant", "casual_restaurant"],
  ])("%s → %s", (text, bucket) => {
    expect(bucketFromText(text)).toBe(bucket);
  });

  it("returns null for categories outside the buckets", () => {
    expect(bucketFromText("Retail > Clothing Store")).toBeNull();
    expect(bucketFromText("")).toBeNull();
  });
});

describe("bucketFromFsqLabels", () => {
  it("takes the most specific bucket across a venue's labels", () => {
    expect(
      bucketFromFsqLabels(["Dining and Drinking > Bar > Cocktail Bar", "Travel and Transportation > Lodging > Hotel"])
    ).toBe("hotel");
  });

  it("is null when no label maps", () => {
    expect(bucketFromFsqLabels(["Retail > Bookstore", null])).toBeNull();
  });
});

describe("bucketFromGoogle", () => {
  it("prefers the primary type", () => {
    expect(bucketFromGoogle("steak_house", ["restaurant", "bar"])).toBe("steakhouse_grill");
  });

  it("maps cuisine restaurant types to casual restaurant", () => {
    expect(bucketFromGoogle("greek_restaurant", ["restaurant", "food"])).toBe("casual_restaurant");
  });

  it("skips generic types before falling back", () => {
    expect(bucketFromGoogle("restaurant", ["food", "bar"])).toBe("bar_lounge");
    expect(bucketFromGoogle(null, ["restaurant", "food"])).toBe("casual_restaurant");
    expect(bucketFromGoogle(null, ["point_of_interest"])).toBeNull();
  });

  it("agrees with the text rules on the same venue kinds", () => {
    expect(bucketFromGoogle("pizza_restaurant")).toBe(bucketFromText("Dining and Drinking > Restaurant > Pizzeria"));
    expect(bucketFromGoogle("bar_and_grill")).toBe(bucketFromText("Bar and Grill"));
    expect(bucketFromGoogle("banquet_hall")).toBe(bucketFromText("banquet hall"));
  });
});

describe("bucketForVenue", () => {
  it("falls back to the category text, then the reference bucket", () => {
    expect(bucketForVenue({ category: "Hotel event space" })).toBe("event_space");
    expect(bucketForVenue({ category: "Something else" })).toBe("casual_restaurant");
  });
});
