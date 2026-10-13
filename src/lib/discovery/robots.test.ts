import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createRobotsChecker,
  fetchRobotsPolicy,
  isPathAllowed,
  parseRobotsTxt,
  ROBOTS_AGENT_TOKEN,
} from "@/lib/discovery/robots";
import { scrapeVenueForPrivateDining } from "@/lib/discovery/scraper";
import { buildVenueDraft, ROBOTS_BLOCKED_NOTE, SITE_UNREACHABLE_NOTE } from "@/lib/discovery/trust";
import { enrichCandidates, type EnrichmentDeps } from "@/lib/discovery/pipeline";
import {
  GARDEN_HOMEPAGE_HTML,
  GARDEN_PRIVATE_HTML,
  GARDEN_PRIVATE_URL,
  GARDEN_SITE,
} from "@/lib/discovery/__fixtures__/garden-room-site";

const allowed = (robots: string, path: string, agent = ROBOTS_AGENT_TOKEN) =>
  isPathAllowed(parseRobotsTxt(robots, agent), path);

describe("RFC 9309 matching", () => {
  it("uses the longest matching rule (§2.2.2)", () => {
    const txt = "User-agent: *\nDisallow: /private\nAllow: /private/events\n";
    expect(allowed(txt, "/private/events/rooms")).toBe(true);
    expect(allowed(txt, "/private/menu")).toBe(false);
  });

  it("lets allow win a tie of equal length", () => {
    expect(allowed("User-agent: *\nDisallow: /page\nAllow: /page\n", "/page")).toBe(true);
  });

  it("supports * and $ (§2.2.3)", () => {
    const txt = "User-agent: *\nDisallow: /*.pdf$\nDisallow: /tmp*/cache\n";
    expect(allowed(txt, "/menus/private.pdf")).toBe(false);
    expect(allowed(txt, "/menus/private.pdf?v=2")).toBe(true);
    expect(allowed(txt, "/tmp123/cache/x")).toBe(false);
  });

  it("treats an empty Disallow as no restriction", () => {
    expect(allowed("User-agent: *\nDisallow:\n", "/anything")).toBe(true);
  });

  it("prefers our own group and then ignores * entirely (§2.2.1)", () => {
    const txt = "User-agent: *\nDisallow: /\n\nUser-agent: Private-Dining-Finder\nDisallow: /admin\n";
    expect(allowed(txt, "/private-events")).toBe(true);
    expect(allowed(txt, "/admin/x")).toBe(false);
  });

  it("matches the product token case-insensitively, ignoring version text", () => {
    const txt = "User-agent: private-dining-finder/0.1\nDisallow: /\n";
    expect(allowed(txt, "/")).toBe(false);
  });

  it("merges every group that names us, and groups sharing several agents", () => {
    const txt =
      "User-agent: otherbot\nUser-agent: private-dining-finder\nDisallow: /a\n\nUser-agent: private-dining-finder\nDisallow: /b\n";
    expect(allowed(txt, "/a")).toBe(false);
    expect(allowed(txt, "/b")).toBe(false);
    expect(allowed(txt, "/c")).toBe(true);
  });

  it("falls back to * when no group names us", () => {
    expect(allowed("User-agent: googlebot\nDisallow: /\n\nUser-agent: *\nDisallow: /x\n", "/y")).toBe(true);
    expect(allowed("User-agent: googlebot\nDisallow: /\n", "/y")).toBe(true);
  });

  it("always allows /robots.txt itself", () => {
    expect(allowed("User-agent: *\nDisallow: /\n", "/robots.txt")).toBe(true);
  });

  it("ignores comments", () => {
    expect(allowed("User-agent: * # everyone\nDisallow: /x # not this\n", "/x")).toBe(false);
  });
});

describe("robots.txt access rules (§2.3.1)", () => {
  const respond = (status: number, body = "", headers: Record<string, string> = {}) =>
    vi.fn(async () => new Response(body, { status, headers }));

  it("4xx (including 404) allows everything", async () => {
    expect(await fetchRobotsPolicy("https://a.example", undefined, respond(404))).toEqual({ kind: "allow-all" });
    expect(await fetchRobotsPolicy("https://a.example", undefined, respond(403))).toEqual({ kind: "allow-all" });
  });

  it("5xx disallows everything", async () => {
    expect(await fetchRobotsPolicy("https://a.example", undefined, respond(503))).toEqual({
      kind: "disallow-all",
      reason: "unreachable",
    });
  });

  it("a network error disallows everything", async () => {
    const failing = vi.fn(async () => {
      throw new Error("ECONNRESET");
    });
    expect(await fetchRobotsPolicy("https://a.example", undefined, failing)).toEqual({
      kind: "disallow-all",
      reason: "unreachable",
    });
  });

  it("a timeout (3 s) disallows everything", async () => {
    vi.useFakeTimers();
    const hanging = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) =>
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")))
        )
    );
    const pending = fetchRobotsPolicy("https://a.example", undefined, hanging);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await pending).toEqual({ kind: "disallow-all", reason: "unreachable" });
    vi.useRealTimers();
  });

  it("follows up to 5 redirects, then treats the file as unavailable", async () => {
    let hops = 0;
    const redirecting = vi.fn(async () => {
      hops += 1;
      return new Response("", { status: 301, headers: { location: `/robots-${hops}.txt` } });
    });
    expect(await fetchRobotsPolicy("https://a.example", undefined, redirecting)).toEqual({ kind: "allow-all" });
    expect(redirecting).toHaveBeenCalledTimes(6);

    const once = vi
      .fn()
      .mockResolvedValueOnce(new Response("", { status: 302, headers: { location: "https://cdn.example/robots.txt" } }))
      .mockResolvedValueOnce(new Response("User-agent: *\nDisallow: /\n", { status: 200 }));
    expect(await fetchRobotsPolicy("https://a.example", undefined, once)).toMatchObject({ kind: "rules" });
    expect(once.mock.calls[1][0]).toBe("https://cdn.example/robots.txt");
  });

  it("tells an unreachable robots.txt apart from a real Disallow", async () => {
    const down = createRobotsChecker(undefined, respond(503));
    expect(await down.check("https://down.example/")).toEqual({ allowed: false, unreachable: true });
    expect([...down.unreachableHosts]).toEqual(["down.example"]);
    expect(down.skippedHosts.size).toBe(0);

    const disallowing = createRobotsChecker(undefined, respond(200, "User-agent: *\nDisallow: /\n"));
    expect(await disallowing.check("https://shy.example/")).toEqual({ allowed: false, unreachable: false });
    expect([...disallowing.skippedHosts]).toEqual(["shy.example"]);
  });

  it("fetches each host's robots.txt once per run", async () => {
    const fetchImpl = respond(200, "User-agent: *\nDisallow: /x\n");
    const checker = createRobotsChecker(undefined, fetchImpl);
    await Promise.all([checker.isAllowed("https://a.example/1"), checker.isAllowed("https://a.example/x/2")]);
    await checker.isAllowed("https://a.example/3");

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect([...checker.skippedHosts]).toEqual(["a.example"]);
  });
});

describe("honouring robots.txt while scraping", () => {
  afterEach(() => vi.unstubAllGlobals());

  function site(robots: string) {
    return vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const html = (body: string) => new Response(body, { status: 200, headers: { "content-type": "text/html" } });
      if (url === `${GARDEN_SITE}robots.txt`) return new Response(robots, { status: 200 });
      if (url === GARDEN_SITE) return html(GARDEN_HOMEPAGE_HTML);
      if (url === GARDEN_PRIVATE_URL) return html(GARDEN_PRIVATE_HTML);
      return new Response("", { status: 404 });
    });
  }

  it("skips a disallowed subpage", async () => {
    const fetchMock = site("User-agent: *\nDisallow: /private-events\n");
    vi.stubGlobal("fetch", fetchMock);
    const signals = await scrapeVenueForPrivateDining(GARDEN_SITE);

    expect(fetchMock.mock.calls.map((c) => String(c[0]))).not.toContain(GARDEN_PRIVATE_URL);
    expect(signals.privateDiningPageFound).toBe(false);
  });

  it("drafts a venue whose homepage is disallowed like a no-website venue", async () => {
    vi.stubGlobal("fetch", site("User-agent: private-dining-finder\nDisallow: /\n"));
    const signals = await scrapeVenueForPrivateDining(GARDEN_SITE);
    const draft = buildVenueDraft(
      {
        placeSourceId: "g",
        name: "Garden",
        formattedAddress: "",
        lat: 0,
        lng: 0,
        category: "restaurant",
        website: GARDEN_SITE,
      },
      signals
    );

    expect(signals.robotsBlocked).toBe(true);
    expect(signals.scrapedUrls).toEqual([]);
    expect(draft.sourceNote).toBe(ROBOTS_BLOCKED_NOTE);
    expect(draft.rooms[0]).toMatchObject({ capacityTrust: "unverified", isEstimate: true });
  });

  it("never tells the planner a site asked not to be crawled when it was simply unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("ENOTFOUND")))
    );
    const signals = await scrapeVenueForPrivateDining(GARDEN_SITE);
    const draft = buildVenueDraft(
      {
        placeSourceId: "g",
        name: "Garden",
        formattedAddress: "",
        lat: 0,
        lng: 0,
        category: "restaurant",
        website: GARDEN_SITE,
      },
      signals
    );

    expect(signals.siteUnreachable).toBe(true);
    expect(signals.robotsBlocked).toBeUndefined();
    expect(draft.sourceNote).toBe(SITE_UNREACHABLE_NOTE);
    expect(draft.sourceNote).not.toBe(ROBOTS_BLOCKED_NOTE);
    expect(draft.rooms[0]).toMatchObject({ capacityTrust: "unverified", isEstimate: true });
  });

  it("counts blocked venues and skipped hosts in the run summary", async () => {
    const deps: EnrichmentDeps = {
      scrape: async (website) => ({
        ...(await Promise.resolve({
          privateDiningPageFound: false,
          scrapedUrls: [],
          capacityNumbers: [],
          minSpendUsd: [],
          email: null,
          phone: null,
          descriptionExcerpt: null,
          menuUrl: null,
          dietaryNotes: null,
          renderedWithJs: false,
          combinedText: "",
        })),
        robotsBlocked: website.includes("blocked"),
        renderTarget: null,
      }),
      render: async () => null,
      extract: async () => null,
      isLlmConfigured: () => false,
    };
    const candidates = ["https://blocked-a.example/", "https://open.example/", "https://blocked-b.example/"].map(
      (website, i) => ({
        placeSourceId: `${i}`,
        name: `V${i}`,
        formattedAddress: "",
        lat: 0,
        lng: 0,
        category: "bar",
        website,
      })
    );

    const { stats, drafts } = await enrichCandidates(candidates, deps);

    expect(stats.robotsBlockedVenues).toBe(2);
    expect(drafts.filter((d) => d.sourceNote === ROBOTS_BLOCKED_NOTE)).toHaveLength(2);
  });
});
