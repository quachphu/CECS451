import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { clearPlacePhotoCache, fetchPlacePhoto } from "@/lib/place-photo";

const STORED = "places/ChIJplace1/photos/AaExpiredToken";
const FRESH = "places/ChIJplace1/photos/AaFreshToken";

function image() {
  return new Response("jpeg-bytes", { status: 200, headers: { "content-type": "image/jpeg" } });
}

function invalidPhoto() {
  return new Response(JSON.stringify({ error: { code: 400, status: "INVALID_ARGUMENT" } }), { status: 400 });
}

/** Google stub: only names in `valid` serve media; details returns `detailsName`. */
function google(valid: string[], detailsName: string | null = FRESH) {
  return vi.fn(async (input: string | URL) => {
    const url = String(input);
    if (url.includes("/media")) {
      return valid.some((n) => url.includes(`/v1/${n}/media`)) ? image() : invalidPhoto();
    }
    return new Response(JSON.stringify(detailsName ? { photos: [{ name: detailsName }] } : {}), { status: 200 });
  });
}

describe("fetchPlacePhoto", () => {
  beforeEach(() => {
    clearPlacePhotoCache();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("serves a still-valid stored name with a single request", async () => {
    const fetchImpl = google([STORED]);
    const res = await fetchPlacePhoto(STORED, "key", fetchImpl as unknown as typeof fetch);

    expect(await res!.text()).toBe("jpeg-bytes");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("recovers from an expired stored name by looking up a fresh one for the same place", async () => {
    const fetchImpl = google([FRESH]);
    const res = await fetchPlacePhoto(STORED, "key", fetchImpl as unknown as typeof fetch);

    expect(await res!.text()).toBe("jpeg-bytes");
    expect(String(fetchImpl.mock.calls[1][0])).toBe("https://places.googleapis.com/v1/places/ChIJplace1");
  });

  it("reuses the fresh name on the next view instead of retrying the expired one", async () => {
    const fetchImpl = google([FRESH]);
    await fetchPlacePhoto(STORED, "key", fetchImpl as unknown as typeof fetch);
    fetchImpl.mockClear();

    await fetchPlacePhoto(STORED, "key", fetchImpl as unknown as typeof fetch);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0][0])).toContain(`/v1/${FRESH}/media`);
  });

  it("returns null when the place no longer has any photo", async () => {
    const fetchImpl = google([], null);

    expect(await fetchPlacePhoto(STORED, "key", fetchImpl as unknown as typeof fetch)).toBeNull();
  });

  it("returns null rather than throwing when Google is unreachable", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });

    expect(await fetchPlacePhoto(STORED, "key", fetchImpl as unknown as typeof fetch)).toBeNull();
  });
});
