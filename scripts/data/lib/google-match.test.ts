import { describe, expect, it } from "vitest";
import { decideMatch, nameSimilarity } from "./google-match";

const venue = { name: "Perbacco Ristorante", lat: 37.7936, lng: -122.3993, website: "https://www.perbaccosf.com" };

describe("nameSimilarity", () => {
  it("is token Jaccard, ignoring case, accents, punctuation and 'the'", () => {
    expect(nameSimilarity("The Café Lafayette", "cafe lafayette")).toBe(1);
    expect(nameSimilarity("Perbacco Ristorante", "Perbacco")).toBe(0.5);
    expect(nameSimilarity("Joe & Sons", "Joe and Sons")).toBe(1);
  });
});

describe("decideMatch", () => {
  it("accepts a nearby place with a similar name", () => {
    const d = decideMatch(venue, { name: "Perbacco Ristorante + Bar", lat: 37.7937, lng: -122.3994, websiteUri: null });
    expect(d.accepted).toBe(true);
  });

  it("accepts a nearby place with a different name but the same website domain", () => {
    const d = decideMatch(venue, {
      name: "Perbacco",
      lat: 37.7937,
      lng: -122.3994,
      websiteUri: "http://perbaccosf.com/menu",
    });
    expect(d.nameSimilarity).toBeLessThan(0.6);
    expect(d.domainMatch).toBe(true);
    expect(d.accepted).toBe(true);
  });

  it("rejects a matching name more than 150 m away", () => {
    const d = decideMatch(venue, { name: "Perbacco Ristorante", lat: 37.7966, lng: -122.3993, websiteUri: null });
    expect(d.distanceM).toBeGreaterThan(150);
    expect(d.accepted).toBe(false);
  });

  it("rejects a nearby place with neither a similar name nor the same domain", () => {
    const d = decideMatch(venue, {
      name: "Tadich Grill",
      lat: 37.7936,
      lng: -122.3993,
      websiteUri: "https://tadichgrill.com",
    });
    expect(d.accepted).toBe(false);
  });

  it("rejects a result without coordinates", () => {
    expect(decideMatch(venue, { name: "Perbacco Ristorante", lat: null, lng: null, websiteUri: null }).accepted).toBe(
      false
    );
  });
});
