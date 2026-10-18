import { afterEach, describe, expect, it, vi } from "vitest";
import {
  detectLanguage,
  RESEARCH_USER_AGENT,
  snapshotVenue,
  type FetchLike,
  type Renderer,
} from "./snapshot-core";

type Route = {
  status?: number;
  body?: string;
  type?: string;
  location?: string;
};

/** An in-memory website: URL → response. Unknown URLs are 404. Records every request. */
function site(routes: Record<string, Route | (() => Promise<Response>)>) {
  const requests: Array<{ url: string; ua: string | null }> = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const ua = new Headers(init?.headers).get("user-agent");
    requests.push({ url: input, ua });
    const route = routes[input];
    if (typeof route === "function") return route();
    if (!route) return new Response("not found", { status: 404 });
    return new Response(route.body ?? "", {
      status: route.status ?? 200,
      headers: {
        "content-type": route.type ?? "text/html",
        ...(route.location ? { location: route.location } : {}),
      },
    });
  };
  return { fetchImpl, requests };
}

const LONG =
  "We serve seasonal Californian food every night of the week in the heart of the city. ".repeat(
    10,
  );
const html = (body: string) => `<html><body>${body}</body></html>`;
const HOME = "https://www.examplegrill.com";
const venue = { venue_id: "sf-0001", website: HOME };
const noWait = async () => {};

const HOME_PAGE = html(`
  <p>${LONG}</p>
  <a href="/private-events">Private Events</a>
  <a href="/about">About us</a>
  <a href="https://www.tripleseat.com/party/request/77">Plan a party</a>
  <a href="/files/private-events-packet.pdf">Events packet</a>
`);
const PRIVATE_PAGE = html(
  `<h1>Private Dining</h1><p>The Garden Room seats 40 guests for private dinners. ${LONG}</p>`,
);

describe("snapshotVenue", () => {
  afterEach(() => vi.useRealTimers());

  it("saves the homepage and private-dining page and inventories event links", async () => {
    const { fetchImpl, requests } = site({
      [`${HOME}/robots.txt`]: {
        body: "User-agent: *\nAllow: /\n",
        type: "text/plain",
      },
      [HOME]: { body: HOME_PAGE },
      [`${HOME}/private-events`]: { body: PRIVATE_PAGE },
    });
    const snap = await snapshotVenue(venue, {
      fetchImpl,
      render: null,
      wait: noWait,
    });

    expect(snap.fetch_outcome).toBe("ok");
    expect(snap.robots).toBe("allowed");
    expect(snap.pages.map((p) => [p.kind, p.method])).toEqual([
      ["homepage", "static"],
      ["private_dining", "static"],
    ]);
    expect(snap.pages[1].text).toContain("seats 40 guests");
    expect(snap.pages[1].sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(snap.external_event_links).toEqual([
      "https://www.tripleseat.com/party/request/77",
    ]);
    expect(snap.pdf_links).toEqual([`${HOME}/files/private-events-packet.pdf`]);
    expect(snap.language).toBe("en");
    expect(requests.every((r) => r.ua === RESEARCH_USER_AGENT)).toBe(true);
  });

  it("stops at robots.txt when the homepage is disallowed", async () => {
    const { fetchImpl, requests } = site({
      [`${HOME}/robots.txt`]: {
        body: "User-agent: *\nDisallow: /\n",
        type: "text/plain",
      },
      [HOME]: { body: HOME_PAGE },
    });
    const snap = await snapshotVenue(venue, {
      fetchImpl,
      render: null,
      wait: noWait,
    });
    expect([snap.fetch_outcome, snap.robots]).toEqual([
      "robots_blocked",
      "disallowed",
    ]);
    expect(requests.map((r) => r.url)).toEqual([`${HOME}/robots.txt`]);
  });

  it("treats a 5xx robots.txt as disallowed for this run", async () => {
    const { fetchImpl } = site({
      [`${HOME}/robots.txt`]: { status: 503 },
      [HOME]: { body: HOME_PAGE },
    });
    const snap = await snapshotVenue(venue, {
      fetchImpl,
      render: null,
      wait: noWait,
    });
    expect([snap.fetch_outcome, snap.robots]).toEqual([
      "robots_blocked",
      "unavailable",
    ]);
  });

  it("treats a missing robots.txt (4xx) as allowed", async () => {
    const { fetchImpl } = site({ [HOME]: { body: html(`<p>${LONG}</p>`) } });
    expect(
      (await snapshotVenue(venue, { fetchImpl, render: null, wait: noWait }))
        .fetch_outcome,
    ).toBe("ok");
  });

  it("skips candidate pages that robots.txt disallows", async () => {
    const { fetchImpl, requests } = site({
      [`${HOME}/robots.txt`]: {
        body: "User-agent: *\nDisallow: /private-events\n",
        type: "text/plain",
      },
      [HOME]: { body: HOME_PAGE },
      [`${HOME}/private-events`]: { body: PRIVATE_PAGE },
    });
    const snap = await snapshotVenue(venue, {
      fetchImpl,
      render: null,
      wait: noWait,
    });
    expect(snap.pages).toHaveLength(1);
    expect(requests.some((r) => r.url.endsWith("/private-events"))).toBe(false);
  });

  it("marks parked and closed domains", async () => {
    const parked = site({
      [HOME]: { body: html(`<h1>This domain is for sale!</h1><p>${LONG}</p>`) },
    });
    expect(
      (
        await snapshotVenue(venue, {
          fetchImpl: parked.fetchImpl,
          render: null,
          wait: noWait,
        })
      ).fetch_outcome,
    ).toBe("parked_or_closed");
    const registrar = site({
      [HOME]: {
        status: 301,
        location:
          "https://www.hugedomains.com/domain_profile.cfm?d=examplegrill",
      },
      "https://www.hugedomains.com/domain_profile.cfm?d=examplegrill": {
        body: html(`<p>${LONG}</p>`),
      },
    });
    expect(
      (
        await snapshotVenue(venue, {
          fetchImpl: registrar.fetchImpl,
          render: null,
          wait: noWait,
        })
      ).fetch_outcome,
    ).toBe("parked_or_closed");
  });

  it("renders a blocked homepage with Firecrawl and counts the credit", async () => {
    const { fetchImpl } = site({
      [HOME]: { status: 403, body: "Access denied" },
    });
    const render: Renderer = vi.fn(async () => ({
      text: `${LONG} [Private events](${HOME}/events)`,
      status: 200,
      credits: 1,
    }));
    const snap = await snapshotVenue(venue, {
      fetchImpl,
      render,
      wait: noWait,
    });
    expect(snap.fetch_outcome).toBe("ok");
    expect(snap.pages[0]).toMatchObject({
      kind: "homepage",
      method: "firecrawl",
    });
    expect(snap.credits_used).toBeGreaterThanOrEqual(1);
    expect(render).toHaveBeenCalledWith(HOME, "page");
  });

  it("reports bot_blocked when blocked and rendering is unavailable", async () => {
    const { fetchImpl } = site({
      [HOME]: { status: 403, body: "Access denied" },
    });
    expect(
      (await snapshotVenue(venue, { fetchImpl, render: null, wait: noWait }))
        .fetch_outcome,
    ).toBe("bot_blocked");
  });

  it("renders an empty (client-side) homepage, and reports empty_after_render when rendering doesn't help", async () => {
    const { fetchImpl } = site({
      [HOME]: { body: html('<div id="root"></div>') },
    });
    const helps: Renderer = async () => ({
      text: LONG,
      status: 200,
      credits: 1,
    });
    expect(
      (await snapshotVenue(venue, { fetchImpl, render: helps, wait: noWait }))
        .pages[0].method,
    ).toBe("firecrawl");
    const useless: Renderer = async () => ({
      text: "Loading…",
      status: 200,
      credits: 1,
    });
    const snap = await snapshotVenue(venue, {
      fetchImpl,
      render: useless,
      wait: noWait,
    });
    expect(snap.fetch_outcome).toBe("empty_after_render");
    expect(snap.credits_used).toBe(1);
  });

  it("reports http_error for other failures and timeout for a hung site", async () => {
    const broken = site({ [HOME]: { status: 500, body: "oops" } });
    expect(
      (
        await snapshotVenue(venue, {
          fetchImpl: broken.fetchImpl,
          render: null,
          wait: noWait,
        })
      ).fetch_outcome,
    ).toBe("http_error");

    vi.useFakeTimers();
    const hung: FetchLike = (input, init) =>
      input.endsWith("robots.txt")
        ? Promise.resolve(new Response("", { status: 404 }))
        : new Promise((_, reject) =>
            init?.signal?.addEventListener("abort", () =>
              reject(
                Object.assign(new Error("aborted"), { name: "AbortError" }),
              ),
            ),
          );
    const pending = snapshotVenue(venue, {
      fetchImpl: hung,
      render: null,
      wait: noWait,
    });
    await vi.advanceTimersByTimeAsync(8_000);
    expect((await pending).fetch_outcome).toBe("timeout");
  });

  it("parses event PDFs only when allowed, most event-specific first", async () => {
    const { fetchImpl } = site({
      [HOME]: { body: HOME_PAGE },
      [`${HOME}/private-events`]: { body: PRIVATE_PAGE },
    });
    const render = vi.fn<Renderer>(async () => ({
      text: "Banquet packet: the Loft seats 80 guests.",
      status: 200,
      credits: 3,
    }));

    const without = await snapshotVenue(venue, {
      fetchImpl,
      render,
      wait: noWait,
    });
    expect(without.pages.some((p) => p.kind === "pdf")).toBe(false);

    const withPdf = await snapshotVenue(venue, {
      fetchImpl,
      render,
      wait: noWait,
      pdfAllowance: 1,
    });
    expect(withPdf.pages.at(-1)).toMatchObject({
      kind: "pdf",
      method: "firecrawl_pdf",
    });
    expect(render).toHaveBeenLastCalledWith(
      `${HOME}/files/private-events-packet.pdf`,
      "pdf",
    );
    expect(withPdf.credits_used).toBe(3);
  });

  it("reports no_website without any request", async () => {
    const { fetchImpl, requests } = site({});
    expect(
      (
        await snapshotVenue(
          { venue_id: "x", website: null },
          { fetchImpl, render: null, wait: noWait },
        )
      ).fetch_outcome,
    ).toBe("no_website");
    expect(requests).toHaveLength(0);
  });
});

describe("detectLanguage", () => {
  it("tells English from other languages and abstains on short text", () => {
    expect(detectLanguage(LONG)).toBe("en");
    expect(
      detectLanguage(
        "Bienvenidos a nuestro restaurante, ofrecemos cenas privadas para grupos grandes y pequeños ".repeat(
          5,
        ),
      ),
    ).toBe("non_en");
    expect(detectLanguage("Hi")).toBe("unknown");
  });
});
