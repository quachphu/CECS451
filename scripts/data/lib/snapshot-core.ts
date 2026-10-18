/**
 * Saving one venue's pages (Step 3). Pure of global state: network access,
 * rendering and pacing are injected, so this runs the same against real sites
 * and against the in-memory test sites in snapshot-core.test.ts.
 *
 * Reads pages with the app's own rules — the same text extraction
 * (textFromHtml) and the same private-dining keyword rule — so the training
 * data is what the app would have read.
 */
import { isEventPdfLink, isExternalEventLink } from "../../../src/lib/discovery/web-links";
import { createRobotsChecker, ROBOTS_AGENT_TOKEN } from "../../../src/lib/discovery/robots";
import { PRIVATE_DINING_KEYWORDS, textFromHtml } from "../../../src/lib/discovery/scraper";
import { sha256 } from "./io";

export const RESEARCH_USER_AGENT =
  "private-dining-finder/0.2 (CSULB CECS 451 research; contact: quachphuwork@gmail.com)";

export const FETCH_TIMEOUT_MS = 8_000;
export const MAX_REDIRECTS = 5;
export const MAX_CANDIDATE_PAGES = 2;
/** Less visible text than this counts as an empty page (rendered client-side). */
export const MIN_VISIBLE_CHARS = 500;

export type FetchOutcome =
  | "ok"
  | "no_website"
  | "robots_blocked"
  | "http_error"
  | "timeout"
  | "bot_blocked"
  | "empty_after_render"
  | "parked_or_closed";

export type SnapshotPage = {
  url: string;
  kind: "homepage" | "private_dining" | "other" | "pdf";
  status: number | null;
  method: "static" | "firecrawl" | "firecrawl_pdf";
  text: string;
  chars: number;
  sha256: string;
};

export type Snapshot = {
  venue_id: string;
  website: string | null;
  robots: "allowed" | "disallowed" | "unavailable" | "not_checked";
  fetch_outcome: FetchOutcome;
  pages: SnapshotPage[];
  external_event_links: string[];
  pdf_links: string[];
  language: "en" | "non_en" | "unknown";
  fetched_at: string;
  credits_used: number;
  notes?: string[];
};

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Firecrawl (or a test double): rendered text of a page or PDF, and the credits charged. */
export type Renderer = (
  url: string,
  mode: "page" | "pdf"
) => Promise<{ text: string; status: number | null; credits: number } | null>;

export type SnapshotDeps = {
  fetchImpl: FetchLike;
  /** Null when rendering is unavailable or its budget is spent. */
  render: Renderer | null;
  /** Resolves when the next request to this venue's host may be sent (politeness). */
  wait: () => Promise<void>;
  now?: () => string;
  /** How many event PDFs this venue may parse (0 = none). */
  pdfAllowance?: number;
};

type StaticResult =
  | { kind: "ok"; status: number; finalUrl: string; html: string; redirectHosts: string[] }
  | { kind: "status"; status: number; finalUrl: string; body: string }
  | { kind: "timeout" }
  | { kind: "network" };

/** One static GET, following up to five redirects by hand so registrar redirects are visible. */
export async function fetchStatic(url: string, fetchImpl: FetchLike): Promise<StaticResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const redirectHosts: string[] = [];
  let current = url;
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const res = await fetchImpl(current, {
        redirect: "manual",
        signal: controller.signal,
        headers: { "User-Agent": RESEARCH_USER_AGENT, Accept: "text/html,application/xhtml+xml" },
      });
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        if (!location || hop === MAX_REDIRECTS)
          return { kind: "status", status: res.status, finalUrl: current, body: "" };
        current = new URL(location, current).toString();
        redirectHosts.push(new URL(current).hostname);
        continue;
      }
      const body = await res.text();
      const type = res.headers.get("content-type") ?? "";
      if (!res.ok) return { kind: "status", status: res.status, finalUrl: current, body };
      if (type && !/html|xml|text\/plain/i.test(type))
        return { kind: "status", status: 415, finalUrl: current, body: "" };
      return { kind: "ok", status: res.status, finalUrl: current, html: body, redirectHosts };
    }
    return { kind: "network" };
  } catch (err) {
    return controller.signal.aborted || (err as Error)?.name === "AbortError"
      ? { kind: "timeout" }
      : { kind: "network" };
  } finally {
    clearTimeout(timer);
  }
}

const REGISTRAR_HOSTS =
  /(^|\.)(godaddy|sedo|dan|afternic|hugedomains|namecheap|parkingcrew|bodis|above|uniregistry|squadhelp|domainmarket|sedoparking|parklogic)\.(com|net|io)$/i;
const PARKED_TEXT =
  /\b(this domain (is|may be) for sale|domain (is )?for sale|buy this domain|domain parked|parked (free|domain)|this domain has expired|permanently closed|closed permanently|has (now )?closed (its doors )?permanently|we('| a)re permanently closed)\b/i;

export function isParkedOrClosed(text: string, redirectHosts: string[]): boolean {
  return redirectHosts.some((h) => REGISTRAR_HOSTS.test(h)) || PARKED_TEXT.test(text.slice(0, 4000));
}

const CHALLENGE =
  /just a moment\.\.\.|attention required! \| cloudflare|cf-chl-|cf_chl_|checking your browser|ddos protection by|captcha|access denied|request unsuccessful\. incapsula|perimeterx|px-captcha/i;

export function isBotChallenge(status: number, body: string): boolean {
  return status === 403 || status === 429 || CHALLENGE.test(body.slice(0, 20000));
}

// Words that are common in English and rare in Spanish, French, Italian or German
// ("a", "in" and "on" are left out: they are words in those languages too).
const EN_STOPWORDS = new Set(
  "the and of to for is with our are we you your at be this that from or as by all private event events dining room menu".split(
    " "
  )
);

/** Crude language check: share of common English words. Flags non-English pages for review. */
export function detectLanguage(text: string): Snapshot["language"] {
  const words = text.toLowerCase().match(/[a-zà-ÿ]+/g) ?? [];
  if (words.length < 30) return "unknown";
  const sample = words.slice(0, 2000);
  const hits = sample.filter((w) => EN_STOPWORDS.has(w)).length;
  return hits / sample.length >= 0.08 ? "en" : "non_en";
}

/** Links in rendered markdown, "[text](url)". */
export function markdownLinks(markdown: string): Array<{ href: string; text: string }> {
  return Array.from(markdown.matchAll(/\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g), (m) => ({ href: m[2], text: m[1] }));
}

function page(
  url: string,
  kind: SnapshotPage["kind"],
  status: number | null,
  method: SnapshotPage["method"],
  text: string
): SnapshotPage {
  return { url, kind, status, method, text, chars: text.length, sha256: sha256(text) };
}

/** PDFs most likely to describe private events first. */
export function rankPdfLinks(links: string[]): string[] {
  const score = (u: string) =>
    /private|event/i.test(u) ? 3 : /group|banquet|packet|party|wedding/i.test(u) ? 2 : /menu|catering/i.test(u) ? 1 : 0;
  return [...links].sort((a, b) => score(b) - score(a));
}

export async function snapshotVenue(
  venue: { venue_id: string; website: string | null },
  deps: SnapshotDeps
): Promise<Snapshot> {
  const now = deps.now ?? (() => new Date().toISOString());
  const notes: string[] = [];
  let credits = 0;
  const base: Omit<Snapshot, "fetch_outcome" | "robots"> = {
    venue_id: venue.venue_id,
    website: venue.website,
    pages: [],
    external_event_links: [],
    pdf_links: [],
    language: "unknown",
    fetched_at: now(),
    credits_used: 0,
  };
  const finish = (fetch_outcome: FetchOutcome, robots: Snapshot["robots"]): Snapshot => ({
    ...base,
    fetch_outcome,
    robots,
    credits_used: credits,
    language: detectLanguage(
      base.pages
        .filter((p) => p.kind !== "pdf")
        .map((p) => p.text)
        .join(" ")
    ),
    ...(notes.length ? { notes } : {}),
  });

  if (!venue.website) return finish("no_website", "not_checked");

  // robots.txt first, with our research User-Agent; 4xx = allowed, 5xx/timeout = disallowed for this run.
  const robots = createRobotsChecker(ROBOTS_AGENT_TOKEN, async (input, init) => {
    await deps.wait();
    return deps.fetchImpl(input, { ...init, headers: { "User-Agent": RESEARCH_USER_AGENT } });
  });
  const home = await robots.check(venue.website);
  if (!home.allowed) return finish("robots_blocked", home.unreachable ? "unavailable" : "disallowed");

  /** Firecrawl fallback for an empty or blocked page; returns null when unavailable or still empty. */
  const renderFallback = async (url: string, reason: string) => {
    if (!deps.render) {
      notes.push(`${url}: ${reason}; rendering unavailable`);
      return null;
    }
    const rendered = await deps.render(url, "page");
    if (rendered) credits += rendered.credits;
    if (!rendered || rendered.text.length < MIN_VISIBLE_CHARS) {
      notes.push(`${url}: ${reason}; render ${rendered ? "still empty" : "failed"}`);
      return null;
    }
    return rendered;
  };

  await deps.wait();
  const res = await fetchStatic(venue.website, deps.fetchImpl);
  if (res.kind === "timeout") return finish("timeout", "allowed");
  if (res.kind === "network") return finish("http_error", "allowed");

  let homeUrl = venue.website;
  let homeText: string;
  let links: Array<{ href: string; text: string }>;

  if (res.kind === "status") {
    if (!isBotChallenge(res.status, res.body)) {
      notes.push(`homepage HTTP ${res.status}`);
      return finish("http_error", "allowed");
    }
    const rendered = await renderFallback(venue.website, `blocked (HTTP ${res.status})`);
    if (!rendered) return finish("bot_blocked", "allowed");
    homeText = rendered.text;
    links = markdownLinks(rendered.text);
    base.pages.push(page(venue.website, "homepage", rendered.status, "firecrawl", homeText));
  } else {
    homeUrl = res.finalUrl;
    const parsed = textFromHtml(res.html);
    homeText = parsed.text;
    links = parsed.links;
    if (isBotChallenge(res.status, res.html) && homeText.length < MIN_VISIBLE_CHARS) {
      const rendered = await renderFallback(venue.website, "challenge page");
      if (!rendered) return finish("bot_blocked", "allowed");
      homeText = rendered.text;
      links = markdownLinks(rendered.text);
      base.pages.push(page(homeUrl, "homepage", rendered.status, "firecrawl", homeText));
    } else if (isParkedOrClosed(homeText, res.redirectHosts)) {
      base.pages.push(page(homeUrl, "homepage", res.status, "static", homeText));
      return finish("parked_or_closed", "allowed");
    } else if (homeText.length < MIN_VISIBLE_CHARS) {
      const rendered = await renderFallback(homeUrl, `only ${homeText.length} visible characters`);
      if (!rendered) {
        base.pages.push(page(homeUrl, "homepage", res.status, "static", homeText));
        return finish("empty_after_render", "allowed");
      }
      homeText = rendered.text;
      links = [...links, ...markdownLinks(rendered.text)];
      base.pages.push(page(homeUrl, "homepage", rendered.status, "firecrawl", homeText));
    } else {
      base.pages.push(page(homeUrl, "homepage", res.status, "static", homeText));
    }
  }

  // Link inventory: same-host private-dining pages, third-party event platforms, event PDFs.
  const baseUrl = new URL(homeUrl);
  const candidates: string[] = [];
  const external = new Set<string>();
  const pdfs = new Set<string>();
  for (const { href, text } of links) {
    let resolved: URL;
    try {
      resolved = new URL(href, baseUrl);
    } catch {
      continue;
    }
    if (!/^https?:$/.test(resolved.protocol)) continue;
    resolved.hash = "";
    const abs = resolved.toString();
    if (isExternalEventLink(abs, homeUrl)) external.add(abs);
    if (isEventPdfLink(abs, text)) pdfs.add(abs);
    else if (
      resolved.hostname === baseUrl.hostname &&
      (PRIVATE_DINING_KEYWORDS.test(text) || PRIVATE_DINING_KEYWORDS.test(href)) &&
      abs !== homeUrl &&
      !candidates.includes(abs)
    )
      candidates.push(abs);
  }
  base.external_event_links = Array.from(external);
  base.pdf_links = rankPdfLinks(Array.from(pdfs));

  const allowedCandidates: string[] = [];
  for (const url of candidates) if (await robots.isAllowed(url)) allowedCandidates.push(url);
  for (const url of allowedCandidates.slice(0, MAX_CANDIDATE_PAGES)) {
    await deps.wait();
    const r = await fetchStatic(url, deps.fetchImpl);
    let text: string | null = null;
    let status: number | null = null;
    let method: SnapshotPage["method"] = "static";
    if (r.kind === "ok") {
      text = textFromHtml(r.html).text;
      status = r.status;
      if (text.length < MIN_VISIBLE_CHARS) {
        const rendered = await renderFallback(url, `only ${text.length} visible characters`);
        if (rendered) [text, status, method] = [rendered.text, rendered.status, "firecrawl"];
      }
    } else if (r.kind === "status" && isBotChallenge(r.status, r.body)) {
      const rendered = await renderFallback(url, `blocked (HTTP ${r.status})`);
      if (rendered) [text, status, method] = [rendered.text, rendered.status, "firecrawl"];
    } else {
      notes.push(`${url}: ${r.kind === "status" ? `HTTP ${r.status}` : r.kind}`);
    }
    if (text)
      base.pages.push(page(url, PRIVATE_DINING_KEYWORDS.test(text) ? "private_dining" : "other", status, method, text));
  }

  // Event PDFs, only when allowed for this run (pilot, or approved full parsing).
  const allowance = deps.pdfAllowance ?? 0;
  if (allowance > 0 && deps.render) {
    for (const url of base.pdf_links.slice(0, allowance)) {
      if (!(await robots.isAllowed(url))) continue;
      const parsed = await deps.render(url, "pdf");
      if (parsed) credits += parsed.credits;
      if (parsed?.text) base.pages.push(page(url, "pdf", parsed.status, "firecrawl_pdf", parsed.text));
      else notes.push(`${url}: PDF parse failed`);
    }
  }

  return finish("ok", "allowed");
}
