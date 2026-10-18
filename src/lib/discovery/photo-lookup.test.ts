import { describe, expect, it, vi } from "vitest";
import { lookUpVenuePhoto, namesMatch } from "@/lib/discovery/photo-lookup";

describe("namesMatch", () => {
  it.each([
    ["Perbacco", "Perbacco Ristorante + Bar"],
    ["Chart House Waikiki", "Chart House Waikiki"],
    ["Sheraton Waikiki — Hawaii Ballroom & Lanai Room", "Sheraton Waikiki Beach Resort"],
    ["Tropics Bar & Grill (Hilton Hawaiian Village)", "Tropics Bar & Grill"],
    ["Café Bastille", "Cafe Bastille"],
  ])("matches %s with Google's %s", (ours, google) => {
    expect(namesMatch(ours, google)).toBe(true);
  });

  it.each([
    ["Kokkari Estiatorio", "Perbacco"],
    ["Wayfare Tavern", "The Grove Restaurant & Bar"],
    ["The Bar", "Bar & Grill"],
  ])("rejects %s vs %s", (ours, google) => {
    expect(namesMatch(ours, google)).toBe(false);
  });
});

describe("lookUpVenuePhoto", () => {
  const venue = {
    name: "Perbacco",
    formattedAddress: "230 California St, San Francisco, CA 94111",
    lat: 37.7936,
    lng: -122.3993,
  };

  function searchReturning(places: unknown[]) {
    return vi.fn(async () => new Response(JSON.stringify({ places }), { status: 200 })) as unknown as typeof fetch;
  }

  it("returns the proxy URL for a same-name place at the same spot", async () => {
    const url = await lookUpVenuePhoto(
      venue,
      "key",
      searchReturning([
        {
          displayName: { text: "Perbacco" },
          location: { latitude: 37.7937, longitude: -122.3994 },
          photos: [{ name: "places/ChIJp/photos/AaTok" }],
        },
      ])
    );
    expect(url).toBe("/api/place-photo?name=places%2FChIJp%2Fphotos%2FAaTok");
  });

  it("refuses a same-name place across town (a different branch)", async () => {
    const url = await lookUpVenuePhoto(
      venue,
      "key",
      searchReturning([
        {
          displayName: { text: "Perbacco" },
          location: { latitude: 37.76, longitude: -122.42 },
          photos: [{ name: "places/ChIJx/photos/AaTok" }],
        },
      ])
    );
    expect(url).toBeNull();
  });

  it("refuses a nearby place with a different name", async () => {
    const url = await lookUpVenuePhoto(
      venue,
      "key",
      searchReturning([
        {
          displayName: { text: "Tadich Grill" },
          location: { latitude: 37.7936, longitude: -122.3993 },
          photos: [{ name: "places/ChIJt/photos/AaTok" }],
        },
      ])
    );
    expect(url).toBeNull();
  });

  it("returns null when Google is unreachable", async () => {
    const failing = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    expect(await lookUpVenuePhoto(venue, "key", failing)).toBeNull();
  });
});
