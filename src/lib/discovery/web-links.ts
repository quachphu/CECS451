/**
 * URL helpers shared by the training scripts (sampling, snapshots, splits) and
 * the app (the post-fetch discovery feature `has_external_event_link`).
 */

const TRACKING_PARAMS = /^(utm_[a-z]+|gclid|fbclid|msclkid|mc_cid|mc_eid|yclid|igshid|ref|ref_src|_ga|y_source)$/i;

/**
 * Normalizes a listed website: adds https:// when the scheme is missing, drops
 * tracking parameters, fragments and a trailing slash on the bare host.
 * Returns null when the result still isn't an http(s) URL with a dotted host.
 */
export function normalizeWebsite(raw: string | null | undefined): string | null {
  let s = (raw ?? "").trim();
  if (!s) return null;
  // "mailto:x@y.com" or "tel:…" have a scheme but no "//"; prefixing https://
  // would turn them into a URL with credentials, so reject them outright.
  if (/^[a-z][a-z0-9+.-]*:(?!\/\/)/i.test(s) && !/^[^:/]+\.[a-z]{2,}:\d+/i.test(s)) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s.replace(/^\/+/, "")}`;
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  const host = url.hostname.toLowerCase();
  if (!host.includes(".") || host.endsWith(".") || /\s/.test(host)) return null;
  url.hostname = host;
  url.hash = "";
  for (const key of Array.from(url.searchParams.keys())) if (TRACKING_PARAMS.test(key)) url.searchParams.delete(key);
  const out = url.toString();
  return url.pathname === "/" && !url.search ? out.replace(/\/$/, "") : out;
}

// Multi-label public suffixes common in this dataset's cities and venue sites.
const MULTI_LABEL_SUFFIXES = new Set([
  "co.uk",
  "org.uk",
  "ac.uk",
  "com.au",
  "net.au",
  "co.nz",
  "co.jp",
  "com.mx",
  "com.br",
  "co.za",
  "com.sg",
  "com.hk",
]);

/**
 * The registered domain (eTLD+1): "www.nyc.carminesnyc.com" → "carminesnyc.com".
 * Chains share one site across locations, so this is the unit for de-duplication
 * and for the train/test split. A small built-in suffix list stands in for the
 * full Public Suffix List; see NOTES-training.md.
 */
export function registeredDomain(urlOrHost: string | null | undefined): string | null {
  if (!urlOrHost) return null;
  let host: string;
  try {
    host = new URL(/^[a-z]+:\/\//i.test(urlOrHost) ? urlOrHost : `https://${urlOrHost}`).hostname.toLowerCase();
  } catch {
    return null;
  }
  const labels = host.split(".").filter(Boolean);
  if (labels.length < 2) return null;
  const lastTwo = labels.slice(-2).join(".");
  if (MULTI_LABEL_SUFFIXES.has(lastTwo) && labels.length >= 3) return labels.slice(-3).join(".");
  return lastTwo;
}

/** Listing a page on one of these as "the website" means the venue has no site of its own. */
const SOCIAL_DOMAINS = new Set([
  "instagram.com",
  "facebook.com",
  "fb.com",
  "linktr.ee",
  "yelp.com",
  "tiktok.com",
  "twitter.com",
  "x.com",
  "linkin.bio",
  "beacons.ai",
  "tripadvisor.com",
  "google.com",
  "goo.gl",
  "business.site",
]);

export function isSocialOnlyWebsite(url: string | null | undefined): boolean {
  const domain = registeredDomain(url);
  return domain != null && SOCIAL_DOMAINS.has(domain);
}

/**
 * Third-party private-event booking platforms. A venue linking to one hosts
 * events even when its own pages publish no room details.
 */
const EVENT_PLATFORM_PATTERNS: RegExp[] = [
  /(^|\.)tripleseat\.com$/,
  /(^|\.)sevenrooms\.com$/,
  /(^|\.)perfectvenue\.com$/,
  /(^|\.)eventective\.com$/,
  /(^|\.)peerspace\.com$/,
  /(^|\.)partyslate\.com$/,
  /(^|\.)eventup\.com$/,
  /(^|\.)privateevents\.com$/,
  /(^|\.)reserve\.com$/,
];

export function isExternalEventLink(href: string, venueWebsite?: string | null): boolean {
  let url: URL;
  try {
    url = new URL(href, venueWebsite ?? undefined);
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase();
  if (venueWebsite && registeredDomain(host) === registeredDomain(venueWebsite)) return false;
  if (EVENT_PLATFORM_PATTERNS.some((p) => p.test(host))) return true;
  const path = `${url.pathname}${url.search}`.toLowerCase();
  // Platforms that also take ordinary reservations: only their event/group pages count.
  if (/(^|\.)opentable\.com$/.test(host)) return /private[-_]?dining|privatedining|group|event/.test(path);
  if (/(^|\.)resy\.com$/.test(host)) return /event|private|group/.test(path);
  if (/(^|\.)toasttab\.com$/.test(host)) return /catering|event|group/.test(path);
  return false;
}

const PDF_EVENT_WORDS = /event|private|group|banquet|packet|menu|party|wedding|catering/i;

/** A linked PDF that likely describes events or group menus. */
export function isEventPdfLink(href: string, text: string): boolean {
  if (!/\.pdf($|[?#])/i.test(href)) return false;
  return PDF_EVENT_WORDS.test(href) || PDF_EVENT_WORDS.test(text);
}
