import { describe, expect, it } from "vitest";
import {
  isEventPdfLink,
  isExternalEventLink,
  isSocialOnlyWebsite,
  normalizeWebsite,
  registeredDomain,
} from "@/lib/discovery/web-links";

describe("normalizeWebsite", () => {
  it("adds https when the scheme is missing", () => {
    expect(normalizeWebsite("www.perbaccosf.com")).toBe("https://www.perbaccosf.com");
  });

  it("strips tracking parameters and fragments but keeps real query params", () => {
    expect(normalizeWebsite("https://kokkari.com/private-dining/?utm_source=google&utm_medium=x&loc=sf#top")).toBe(
      "https://kokkari.com/private-dining/?loc=sf"
    );
  });

  it("lowercases the host", () => {
    expect(normalizeWebsite("HTTPS://WWW.Example.COM/Events")).toBe("https://www.example.com/Events");
  });

  it("rejects values that are still not URLs", () => {
    expect(normalizeWebsite("not a website")).toBeNull();
    expect(normalizeWebsite("mailto:info@x.com")).toBeNull();
    expect(normalizeWebsite("localhost")).toBeNull();
    expect(normalizeWebsite("")).toBeNull();
    expect(normalizeWebsite(null)).toBeNull();
  });
});

describe("registeredDomain", () => {
  it("reduces hosts to the registered domain", () => {
    expect(registeredDomain("https://www.nyc.carminesnyc.com/parties")).toBe("carminesnyc.com");
    expect(registeredDomain("hiltonhawaiianvillage.com")).toBe("hiltonhawaiianvillage.com");
  });

  it("keeps one more label under multi-label suffixes", () => {
    expect(registeredDomain("https://www.dishoom.co.uk")).toBe("dishoom.co.uk");
  });

  it("is null for unusable input", () => {
    expect(registeredDomain("localhost")).toBeNull();
    expect(registeredDomain("")).toBeNull();
  });
});

describe("isSocialOnlyWebsite", () => {
  it.each([
    "https://instagram.com/somebar",
    "http://www.facebook.com/x",
    "linktr.ee/venue",
    "https://www.yelp.com/biz/x",
  ])("%s is social-only", (url) => {
    expect(isSocialOnlyWebsite(url)).toBe(true);
  });

  it("does not flag a venue's own site", () => {
    expect(isSocialOnlyWebsite("https://www.doscaminos.com")).toBe(false);
  });
});

describe("isExternalEventLink", () => {
  const site = "https://www.examplegrill.com";

  it("recognizes event-booking platforms", () => {
    expect(isExternalEventLink("https://www.tripleseat.com/party/request/1234", site)).toBe(true);
    expect(isExternalEventLink("https://www.sevenrooms.com/events/examplegrill", site)).toBe(true);
  });

  it("counts reservation platforms only on their event pages", () => {
    expect(isExternalEventLink("https://www.opentable.com/r/example-grill", site)).toBe(false);
    expect(isExternalEventLink("https://www.opentable.com/private-dining/example-grill", site)).toBe(true);
  });

  it("ignores the venue's own links", () => {
    expect(isExternalEventLink("/private-events", site)).toBe(false);
  });
});

describe("isEventPdfLink", () => {
  it("matches event-related PDFs by URL or link text", () => {
    expect(isEventPdfLink("/files/private-events-packet.pdf", "Download")).toBe(true);
    expect(isEventPdfLink("/files/x.pdf", "Group dining menu")).toBe(true);
    expect(isEventPdfLink("/files/careers.pdf", "Jobs")).toBe(false);
    expect(isEventPdfLink("/events", "Events")).toBe(false);
  });
});
