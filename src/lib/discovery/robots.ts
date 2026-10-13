/**
 * robots.txt support per RFC 9309 [S1], mirroring the matching rules of
 * Google's reference parser [C3]:
 *
 *  - Group selection (§2.2.1): user-agent product tokens are matched
 *    case-insensitively on their [A-Za-z_-] prefix. If any group names our
 *    token, only those groups' rules apply (several are merged); otherwise the
 *    `*` groups apply; otherwise everything is allowed.
 *  - Rule matching (§2.2.2, §2.2.3): the most specific (longest) matching
 *    pattern wins; when an allow and a disallow are equally long, allow wins.
 *    `*` matches any sequence, a trailing `$` anchors the end. An empty
 *    pattern matches nothing. /robots.txt itself is always allowed.
 *  - Access (§2.3.1): 2xx → parse; 4xx (including 404) → everything allowed;
 *    5xx, timeout or network error → treat the site as fully disallowed for
 *    this run. Up to 5 redirects are followed (§2.3.1.2); beyond that the file
 *    is treated as unavailable (allowed).
 *  - Limits (§2.5): only the first 500 KiB is parsed.
 *
 * Unlike CPython's urllib.robotparser [C5], which takes the first matching
 * rule, matching here is longest-match as the RFC requires.
 */

/** Our product token in robots.txt `User-agent:` lines. */
export const ROBOTS_AGENT_TOKEN = "private-dining-finder";
export const CRAWLER_USER_AGENT = "private-dining-finder/0.1 (event-planning research tool)";

const ROBOTS_TIMEOUT_MS = 3_000;
const MAX_REDIRECTS = 5;
const MAX_ROBOTS_BYTES = 500 * 1024;

type Rule = { allow: boolean; pattern: string };

/** What a host's robots.txt allows, as resolved for our agent. */
/**
 * What a host's robots.txt allows, as resolved for our agent. `disallow-all`
 * only arises from an unreachable robots.txt (5xx, timeout, network error —
 * §2.3.1.4); an explicit "Disallow: /" is an ordinary `rules` policy. The two
 * are kept apart so a site that is simply down is never described as one that
 * asked not to be crawled.
 */
export type RobotsPolicy =
  | { kind: "allow-all" }
  | { kind: "disallow-all"; reason: "unreachable" }
  | { kind: "rules"; rules: Rule[] };

const ALLOW_ALL: RobotsPolicy = { kind: "allow-all" };
const UNREACHABLE: RobotsPolicy = { kind: "disallow-all", reason: "unreachable" };

/** The [A-Za-z_-] prefix of a user-agent value, lowercased (§2.2.1; ExtractUserAgent in [C3]). */
function productToken(value: string): string {
  return (value.match(/^[A-Za-z_-]*/)?.[0] ?? "").toLowerCase();
}

/** Percent-encodes a pattern or path the same way, so "/café" and "/caf%C3%A9" compare equal (§2.2.2). */
function normalizeEncoding(s: string): string {
  try {
    return encodeURI(decodeURI(s));
  } catch {
    return s;
  }
}

/** Resolves a robots.txt body to the rules that apply to `agentToken`. */
export function parseRobotsTxt(body: string, agentToken: string = ROBOTS_AGENT_TOKEN): RobotsPolicy {
  const token = agentToken.toLowerCase();
  const specific: Rule[] = [];
  const global: Rule[] = [];
  let sawSpecificGroup = false;

  // Current group state: which agents the following rules belong to.
  let groupIsSpecific = false;
  let groupIsGlobal = false;
  let lastLineWasRule = false;

  for (const rawLine of body.slice(0, MAX_ROBOTS_BYTES).split(/\r\n|\r|\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    if (key === "user-agent") {
      // A user-agent line after rules starts a new group (§2.2.1).
      if (lastLineWasRule) {
        groupIsSpecific = false;
        groupIsGlobal = false;
      }
      lastLineWasRule = false;
      if (value === "*" || /^\*\s/.test(value)) {
        groupIsGlobal = true;
      } else if (productToken(value) === token && token.length > 0) {
        groupIsSpecific = true;
        sawSpecificGroup = true;
      }
      continue;
    }

    if (key === "allow" || key === "disallow") {
      lastLineWasRule = true;
      if (!groupIsSpecific && !groupIsGlobal) continue;
      if (value === "") continue; // an empty pattern matches nothing
      const rule = { allow: key === "allow", pattern: normalizeEncoding(value) };
      if (groupIsSpecific) specific.push(rule);
      if (groupIsGlobal) global.push(rule);
    }
    // sitemap and unknown keys are ignored
  }

  if (sawSpecificGroup) return specific.length > 0 ? { kind: "rules", rules: specific } : ALLOW_ALL;
  return global.length > 0 ? { kind: "rules", rules: global } : ALLOW_ALL;
}

function patternMatches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const regex = body
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${regex}${anchored ? "$" : ""}`).test(path);
}

/** Longest matching pattern wins; allow wins a tie (§2.2.2; LongestMatch strategy in [C3]). */
export function isPathAllowed(policy: RobotsPolicy, pathAndQuery: string): boolean {
  if (pathAndQuery === "/robots.txt") return true;
  if (policy.kind === "allow-all") return true;
  if (policy.kind === "disallow-all") return false;

  const path = normalizeEncoding(pathAndQuery || "/");
  let bestAllow = -1;
  let bestDisallow = -1;
  for (const rule of policy.rules) {
    if (!patternMatches(rule.pattern, path)) continue;
    if (rule.allow) bestAllow = Math.max(bestAllow, rule.pattern.length);
    else bestDisallow = Math.max(bestDisallow, rule.pattern.length);
  }
  return bestDisallow <= bestAllow;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Fetches and resolves one origin's robots.txt, applying the §2.3.1 status rules. */
export async function fetchRobotsPolicy(
  origin: string,
  agentToken: string = ROBOTS_AGENT_TOKEN,
  fetchImpl: FetchLike = (input, init) => fetch(input, init)
): Promise<RobotsPolicy> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ROBOTS_TIMEOUT_MS);
  let url = `${origin}/robots.txt`;

  try {
    for (let redirects = 0; ; redirects++) {
      const res = await fetchImpl(url, {
        redirect: "manual",
        signal: controller.signal,
        headers: { "User-Agent": CRAWLER_USER_AGENT },
      });

      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        // Too many redirects (or a redirect with nowhere to go): unavailable → allowed.
        if (!location || redirects >= MAX_REDIRECTS) return ALLOW_ALL;
        url = new URL(location, url).toString();
        continue;
      }
      if (res.ok) return parseRobotsTxt(await res.text(), agentToken);
      if (res.status >= 400 && res.status < 500) return ALLOW_ALL;
      return UNREACHABLE; // 5xx
    }
  } catch {
    return UNREACHABLE; // timeout or network error
  } finally {
    clearTimeout(timeout);
  }
}

export type RobotsDecision = {
  allowed: boolean;
  /** True when the reason it isn't allowed is that robots.txt couldn't be fetched at all. */
  unreachable: boolean;
};

export type RobotsChecker = {
  /** May `url` be fetched, and if not, is that because the site's robots.txt was unreachable? */
  check: (url: string) => Promise<RobotsDecision>;
  /** True when `url` may be fetched. */
  isAllowed: (url: string) => Promise<boolean>;
  /** Hosts with at least one URL skipped because a robots.txt rule disallowed it. */
  skippedHosts: Set<string>;
  /** Hosts skipped because their robots.txt couldn't be fetched (treated as disallowed, §2.3.1.4). */
  unreachableHosts: Set<string>;
};

/**
 * A run-scoped checker: each origin's robots.txt is fetched at most once per
 * run (the promise is cached, so concurrent callers share one request).
 */
export function createRobotsChecker(agentToken: string = ROBOTS_AGENT_TOKEN, fetchImpl?: FetchLike): RobotsChecker {
  const policies = new Map<string, Promise<RobotsPolicy>>();
  const skippedHosts = new Set<string>();
  const unreachableHosts = new Set<string>();

  async function check(url: string): Promise<RobotsDecision> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { allowed: false, unreachable: false };
    }
    let policy = policies.get(parsed.origin);
    if (!policy) {
      policy = fetchRobotsPolicy(parsed.origin, agentToken, fetchImpl);
      policies.set(parsed.origin, policy);
    }
    const resolved = await policy;
    const allowed = isPathAllowed(resolved, `${parsed.pathname}${parsed.search}`);
    const unreachable = !allowed && resolved.kind === "disallow-all";
    if (!allowed) (unreachable ? unreachableHosts : skippedHosts).add(parsed.host);
    return { allowed, unreachable };
  }

  return {
    skippedHosts,
    unreachableHosts,
    check,
    isAllowed: async (url: string) => (await check(url)).allowed,
  };
}

/**
 * isAllowed(url, userAgent): one-off check with its own cache. Prefer a
 * run-scoped createRobotsChecker() when checking many URLs.
 */
export async function isAllowed(url: string, userAgent: string = ROBOTS_AGENT_TOKEN): Promise<boolean> {
  return createRobotsChecker(productToken(userAgent) || ROBOTS_AGENT_TOKEN).isAllowed(url);
}
