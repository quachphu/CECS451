/**
 * Dry run, part 2: replaces global fetch for the data scripts.
 *
 *   DRYRUN_WORLD=<dir>/world.json npx tsx --import ./scripts/data/dryrun/shim.ts scripts/data/03_snapshot.ts --full
 *
 * Serves the synthetic venue websites (*.test), Google Places Text Search,
 * Firecrawl scrape/credit-usage and xAI models/chat-completions from the
 * world, and refuses every other host, so a dry run can never reach a real
 * service. The mock student reads the page text it is sent, like the real
 * model, with seeded noise whose rate rises with ambiguity (k reads differ).
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { WorldVenue } from "./world";

const worldFile = process.env.DRYRUN_WORLD;
if (!worldFile) throw new Error("DRYRUN_WORLD is not set");
const world: WorldVenue[] = JSON.parse(readFileSync(worldFile, "utf8"));
const byHost = new Map(world.map((v) => [v.host, v]));
const byName = new Map(world.map((v) => [v.name.toLowerCase(), v]));
let creditsUsed = 0;
const STARTING_CREDITS = 1362;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const text = (body: string, status = 200, type = "text/html; charset=utf-8") =>
  new Response(body, { status, headers: { "content-type": type } });

function rng(seed: string): () => number {
  let a = parseInt(createHash("sha256").update(seed).digest("hex").slice(0, 8), 16) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ------------------------------------------------------------------ sites

function site(url: URL): Response {
  const v = byHost.get(url.hostname);
  if (!v) return text("not found", 404);
  if (url.pathname === "/robots.txt") {
    if (v.site === "http_error" || v.site === "parked") return text("not found", 404, "text/plain");
    return text(v.robots, 200, "text/plain");
  }
  if (v.site === "http_error") return text("Internal Server Error", 500);
  if (v.site === "bot_challenge")
    return text("<html><head><title>Just a moment...</title></head><body>Checking your browser</body></html>", 403);
  const page = v.pages[url.pathname];
  if (page == null) return text("not found", 404);
  return text(page);
}

// ----------------------------------------------------------------- google

async function google(init: RequestInit | undefined): Promise<Response> {
  const body = JSON.parse(String(init?.body ?? "{}")) as { textQuery?: string };
  const name = (body.textQuery ?? "").split(",")[0].trim().toLowerCase();
  const v = byName.get(name);
  if (!v?.google) return json({});
  const g = v.google;
  return json({
    places: [
      {
        id: g.id,
        displayName: { text: g.name, languageCode: "en" },
        types: g.types,
        primaryType: g.primaryType,
        ...(g.priceLevel ? { priceLevel: g.priceLevel } : {}),
        ...(g.rating != null ? { rating: g.rating } : {}),
        ...(g.userRatingCount != null ? { userRatingCount: g.userRatingCount } : {}),
        ...(g.websiteUri ? { websiteUri: g.websiteUri } : {}),
        location: { latitude: g.lat, longitude: g.lng },
      },
    ],
  });
}

// -------------------------------------------------------------- firecrawl

async function firecrawl(url: URL, init: RequestInit | undefined): Promise<Response> {
  if (url.pathname.endsWith("/team/credit-usage"))
    return json({ success: true, data: { remainingCredits: STARTING_CREDITS - creditsUsed } });
  const { url: target } = JSON.parse(String(init?.body ?? "{}")) as { url: string };
  const t = new URL(target);
  const v = byHost.get(t.hostname);
  const isPdf = t.pathname.endsWith(".pdf");
  const credits = isPdf ? 2 : 1;
  creditsUsed += credits;
  const markdown = v ? (v.rendered[t.pathname] ?? (v.pages[t.pathname] ? stripHtml(v.pages[t.pathname]) : "")) : "";
  return json({
    success: true,
    data: { markdown, metadata: { statusCode: markdown ? 200 : 404, creditsUsed: credits, ...(isPdf ? { numPages: 1 } : {}) } },
  });
}

// ------------------------------------------------------------ mock student

type Fact = { name: string; style: "seated" | "standing" | "unspecified"; value: number; min: number | null; quote: string; ambiguous: boolean; pair?: number };

const N = "(\\d+)";
const ROOM = "([A-Z][\\w' ]+?)";
const FORMS: Array<[RegExp, (m: RegExpMatchArray) => Fact[]]> = [
  [
    new RegExp(`The ${ROOM} seats ${N} guests for a seated dinner and up to ${N} for a standing reception\\.`, "g"),
    (m) => [
      { name: m[1], style: "seated", value: +m[2], min: null, quote: m[0], ambiguous: false, pair: +m[3] },
      { name: m[1], style: "standing", value: +m[3], min: null, quote: m[0], ambiguous: false, pair: +m[2] },
    ],
  ],
  [new RegExp(`Our ${ROOM} accommodates up to ${N} guests\\.`, "g"), (m) => [{ name: m[1], style: "unspecified", value: +m[2], min: null, quote: m[0], ambiguous: false }]],
  [new RegExp(`The ${ROOM} seats ${N} guests\\.`, "g"), (m) => [{ name: m[1], style: "seated", value: +m[2], min: null, quote: m[0], ambiguous: false }]],
  [new RegExp(`The ${ROOM} holds ${N} people standing\\.`, "g"), (m) => [{ name: m[1], style: "standing", value: +m[2], min: null, quote: m[0], ambiguous: false }]],
  [new RegExp(`The ${ROOM} is ideal for groups of ${N} to ${N} guests\\.`, "g"), (m) => [{ name: m[1], style: "unspecified", value: +m[3], min: +m[2], quote: m[0], ambiguous: true }]],
  [/For a full buyout, the entire restaurant welcomes up to (\d+) guests\./g, (m) => [{ name: "Full buyout", style: "unspecified", value: +m[1], min: null, quote: m[0], ambiguous: false }]],
  [new RegExp(`The ${ROOM} and ${ROOM} combine to seat ${N} guests\\.`, "g"), (m) => [{ name: `${m[1]}+${m[2]}`, style: "seated", value: +m[3], min: null, quote: m[0], ambiguous: true }]],
];

const readCounter = new Map<string, number>();

function studentRead(input: string, temperature: number) {
  const key = createHash("sha256").update(input).digest("hex");
  const n = readCounter.get(key) ?? 0;
  readCounter.set(key, n + 1);
  const rand = rng(`${key}:${temperature}:${n}`);
  const facts = FORMS.flatMap(([re, f]) => Array.from(input.matchAll(re)).flatMap(f));
  const numbers = Array.from(input.matchAll(/\b(\d{1,4})\b/g)).map((m) => +m[1]).filter((x) => x >= 2);
  const competing = new Set(numbers).size;
  const rooms = [];
  for (const fact of facts) {
    if (rand() < 0.07) continue; // missed in this read
    let value = fact.value;
    let quote = fact.quote;
    const pErr = 0.05 + 0.03 * Math.max(0, competing - 3) + (fact.ambiguous ? 0.22 : 0);
    if (rand() < pErr) {
      if (fact.pair != null && rand() < 0.4) value = fact.pair; // seated/standing swapped: grounded, wrong
      else {
        const others = numbers.filter((x) => x !== fact.value);
        value = others.length && rand() < 0.5 ? others[Math.floor(rand() * others.length)] : Math.round(fact.value * (1.3 + rand() * 0.8));
        if (rand() < 0.6) quote = `${fact.name} fits about ${value} people`;
      }
    }
    rooms.push({ roomName: fact.name, style: fact.style, maxCapacity: value, minCapacity: fact.min, evidenceQuote: quote });
  }
  const main = /Our main dining room seats (\d+) guests\./.exec(input);
  if (main && rand() < 0.18)
    rooms.push({ roomName: "Main Dining Room", style: "seated", maxCapacity: +main[1], minCapacity: null, evidenceQuote: main[0] });
  if (rand() < 0.04)
    rooms.push({ roomName: "Rooftop Terrace", style: "standing", maxCapacity: 40 + Math.floor(rand() * 120), minCapacity: null, evidenceQuote: "The rooftop terrace is great for receptions" });
  return {
    hostsPrivateEvents: /private (dining|event)|group dinners|celebration/i.test(input),
    rooms,
    minSpendUsd: null,
    minSpendEvidence: null,
    dietaryNotes: null,
  };
}

async function xai(url: URL, init: RequestInit | undefined): Promise<Response> {
  if (url.pathname.endsWith("/models")) return json({ data: [{ id: "grok-4.7" }, { id: "grok-4.7-fast" }] });
  const body = JSON.parse(String(init?.body ?? "{}")) as { model: string; temperature?: number; messages: Array<{ content: string }> };
  const user = body.messages.at(-1)?.content ?? "";
  const input = user.split("Page text:\n").slice(1).join("Page text:\n");
  const out = studentRead(input, body.temperature ?? 0);
  return json({
    id: "dry",
    model: body.model,
    choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(out) }, finish_reason: "stop" }],
    usage: {
      prompt_tokens: Math.ceil(user.length / 4),
      completion_tokens: 120 + 60 * out.rooms.length,
      completion_tokens_details: { reasoning_tokens: 200 },
    },
  });
}

// ------------------------------------------------------------------ fetch

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (url.hostname.endsWith(".test")) return site(url);
  if (url.hostname === "places.googleapis.com") return google(init);
  if (url.hostname === "api.firecrawl.dev") return firecrawl(url, init);
  if (url.hostname === "api.x.ai") return xai(url, init);
  throw new TypeError(`dry run: network access to ${url.hostname} is disabled`);
}) as typeof fetch;
