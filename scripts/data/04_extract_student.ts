/**
 * Step 4: run the app's own extraction (the "student") over each saved venue.
 *
 *   npx tsx scripts/data/04_extract_student.ts            # every in-dataset venue
 *   npx tsx scripts/data/04_extract_student.ts --limit 20 # a pilot
 *
 * Exactly what production does [P3, P7]: private-dining text first, cut at
 * 12,000 characters, k = 3 Grok reads at temperature 0.7 with the strict
 * evidence-quote schema [D2], the grounding check, and features from
 * src/lib/discovery/features.ts. Writes:
 *   eval/extractions.jsonl        one line per extracted room
 *   eval/extraction_venues.jsonl  one line per venue, including zero-room venues
 *
 * Spend is capped by XAI_BUDGET_USD (default 25) at XAI_PRICE_INPUT_PER_M /
 * XAI_PRICE_OUTPUT_PER_M (defaults 2 and 6 USD per million tokens). Per-venue
 * results are cached in eval/.cache/student/, so a rerun resumes.
 */
import { existsSync } from "node:fs";
import {
  SELF_CONSISTENCY_K,
  SELF_CONSISTENCY_TEMPERATURE,
  xaiBaseUrl,
  xaiModel,
} from "../../src/lib/discovery/extraction-config";
import {
  roomConfidenceFeatures,
  type ConfidenceFeatures,
} from "../../src/lib/discovery/features";
import {
  extractWithSelfConsistency,
  type XaiUsage,
} from "../../src/lib/discovery/llm-extract";
import { createLimiter } from "../../src/lib/limiter";
import { Budget, BudgetExceededError, tokenPrice } from "./lib/budget";
import { requireEnv } from "./lib/env";
import {
  cliArgs,
  evalDir,
  readJson,
  writeJsonAtomic,
  writeJsonlAtomic,
} from "./lib/io";
import { RunManifest } from "./lib/manifest";
import { studentInput } from "./lib/student-input";
import { loadSnapshot, readVenueIndex } from "./lib/venue-index";

export type ExtractionRow = {
  venue_id: string;
  room_key: string;
  room_name: string;
  capacity: number;
  min_capacity: number | null;
  style: "seated" | "standing" | "unspecified";
  evidence_quote: string;
  reads: Array<number | null>;
  features: ConfidenceFeatures | null;
  extraction_failed: boolean;
  model: string;
  temperature: number;
};

export type ExtractionVenue = {
  venue_id: string;
  status: "ok" | "extraction_failed" | "no_input";
  successful_reads: number;
  rooms_found: number;
  grounded_rooms: number;
  hosts_private_events: boolean | null;
  private_page_found: boolean;
  input_chars: number;
  model: string;
};

type Cached = { venue: ExtractionVenue; rooms: ExtractionRow[]; usd: number };

function slug(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/\+/g, "-plus-")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export function roomKey(
  venueId: string,
  roomName: string,
  style: string,
  taken: Set<string>,
): string {
  let key = `${venueId}#${slug(roomName) || "room"}${style === "unspecified" ? "" : `@${style}`}`;
  for (let n = 2; taken.has(key); n++) key = `${key.replace(/~\d+$/, "")}~${n}`;
  taken.add(key);
  return key;
}

async function verifyModel(apiKey: string, model: string): Promise<string[]> {
  const res = await fetch(`${xaiBaseUrl()}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok)
    throw new Error(
      `GET /v1/models failed: ${res.status} ${(await res.text()).slice(0, 200)}`,
    );
  const body = (await res.json()) as { data?: Array<{ id: string }> };
  const ids = (body.data ?? []).map((m) => m.id);
  if (!ids.includes(model)) {
    throw new Error(
      `XAI_MODEL "${model}" is not available to this key. Available: ${ids.join(", ") || "(none)"}`,
    );
  }
  return ids;
}

async function main() {
  const { XAI_API_KEY: apiKey } = requireEnv("XAI_API_KEY");
  const { values } = cliArgs();
  const limit = values.has("limit") ? Number(values.get("limit")) : Infinity;
  const model = xaiModel();
  const manifest = new RunManifest("04_extract_student");
  manifest.models.student = model;
  manifest.models.k = String(SELF_CONSISTENCY_K);
  manifest.models.temperature = String(SELF_CONSISTENCY_TEMPERATURE);
  manifest.models.available_models = (await verifyModel(apiKey, model)).join(
    " ",
  );

  const priceIn = tokenPrice("XAI_PRICE_INPUT_PER_M", 2);
  const priceOut = tokenPrice("XAI_PRICE_OUTPUT_PER_M", 6);
  const budget = new Budget(
    "xai",
    "usd",
    Number(process.env.XAI_BUDGET_USD ?? 25),
  );
  const tokens = { prompt: 0, completion: 0, reasoning: 0, calls: 0 };
  // Reasoning tokens are charged as output on top of completion tokens: an
  // overestimate if xAI already counts them in completion_tokens.
  const spentAtStart = budget.spent;
  // One usage callback per venue, so a venue's cost is its own calls only
  // (venues run four at a time against one shared ledger).
  const usageFor = (venueCost: { usd: number }) => (u: XaiUsage) => {
    tokens.prompt += u.promptTokens;
    tokens.completion += u.completionTokens;
    tokens.reasoning += u.reasoningTokens;
    tokens.calls += 1;
    const usd =
      u.promptTokens * priceIn +
      (u.completionTokens + u.reasoningTokens) * priceOut;
    venueCost.usd += usd;
    budget.charge(usd);
  };

  const venues = readVenueIndex().filter((v) => v.in_dataset === "1");
  const cacheFile = (id: string) => evalDir(".cache", "student", `${id}.json`);
  const run = createLimiter(4);
  let status: "ok" | "aborted_budget" = "ok";
  let processed = 0;

  const work = venues.map((v) =>
    run(async () => {
      if (
        existsSync(cacheFile(v.venue_id)) ||
        status !== "ok" ||
        processed >= limit
      )
        return;
      processed++;
      const snap = loadSnapshot(v.venue_id)!;
      const { input, privateDiningPageFound } = studentInput(snap);
      if (!input.trim()) {
        const venue: ExtractionVenue = {
          venue_id: v.venue_id,
          status: "no_input",
          successful_reads: 0,
          rooms_found: 0,
          grounded_rooms: 0,
          hosts_private_events: null,
          private_page_found: privateDiningPageFound,
          input_chars: 0,
          model,
        };
        writeJsonAtomic(cacheFile(v.venue_id), {
          venue,
          rooms: [],
          usd: 0,
        } satisfies Cached);
        return;
      }
      // Worst case for one venue: k reads plus k retries, all input plus 4k output tokens.
      const estimate =
        2 *
        SELF_CONSISTENCY_K *
        ((input.length / 3) * priceIn + 4000 * priceOut);
      try {
        budget.reserve(estimate);
      } catch (err) {
        status = "aborted_budget";
        throw err;
      }
      const venueCost = { usd: 0 };
      const extraction = await extractWithSelfConsistency(v.name, input, {
        onUsage: usageFor(venueCost),
      });
      const successfulReads = extraction?.successfulReads ?? 0;
      const failed = successfulReads < 2;
      const taken = new Set<string>();
      const rooms: ExtractionRow[] = (extraction?.aggregatedRooms ?? []).map(
        (r) => ({
          venue_id: v.venue_id,
          room_key: roomKey(v.venue_id, r.roomName, r.style, taken),
          room_name: r.roomName,
          capacity: r.capacity,
          min_capacity: r.minCapacity,
          style: r.style,
          evidence_quote: r.evidenceQuote,
          reads: r.reads,
          features: failed
            ? null
            : roomConfidenceFeatures(r, input, privateDiningPageFound),
          extraction_failed: failed,
          model,
          temperature: SELF_CONSISTENCY_TEMPERATURE,
        }),
      );
      const venue: ExtractionVenue = {
        venue_id: v.venue_id,
        status: failed ? "extraction_failed" : "ok",
        successful_reads: successfulReads,
        rooms_found: rooms.length,
        grounded_rooms: rooms.filter((r) => r.features?.grounded).length,
        hosts_private_events: extraction ? extraction.hostsPrivateEvents : null,
        private_page_found: privateDiningPageFound,
        input_chars: input.length,
        model,
      };
      writeJsonAtomic(cacheFile(v.venue_id), {
        venue,
        rooms,
        usd: venueCost.usd,
      } satisfies Cached);
    }),
  );
  const results = await Promise.allSettled(work);
  for (const r of results) {
    if (r.status === "rejected" && !(r.reason instanceof BudgetExceededError))
      throw r.reason;
    if (r.status === "rejected") console.error(r.reason.message);
  }

  // Assemble the two files from every cached venue (atomic writes).
  const cached = venues
    .filter((v) => existsSync(cacheFile(v.venue_id)))
    .map((v) => readJson<Cached>(cacheFile(v.venue_id)));
  const rooms = cached.flatMap((c) => c.rooms);
  const venueRows = cached.map((c) => c.venue);
  writeJsonlAtomic(evalDir("extractions.jsonl"), rooms);
  writeJsonlAtomic(evalDir("extraction_venues.jsonl"), venueRows);

  for (const s of ["ok", "extraction_failed", "no_input"])
    manifest.counts[`venues_${s}`] = venueRows.filter(
      (v) => v.status === s,
    ).length;
  manifest.counts.rooms = rooms.length;
  manifest.counts.rooms_grounded = rooms.filter(
    (r) => r.features?.grounded,
  ).length;
  manifest.counts.venues_zero_rooms = venueRows.filter(
    (v) => v.rooms_found === 0,
  ).length;
  manifest.counts.venues_pending = venues.length - cached.length;
  manifest.counts.calls_this_run = tokens.calls;
  manifest.counts.prompt_tokens_this_run = tokens.prompt;
  manifest.counts.completion_tokens_this_run = tokens.completion;
  manifest.counts.reasoning_tokens_this_run = tokens.reasoning;
  manifest.spend.xai_usd_total = Number(budget.spent.toFixed(4));
  manifest.spend.xai_usd_this_run = Number(
    (budget.spent - spentAtStart).toFixed(4),
  );
  manifest.outputs.push(
    evalDir("extractions.jsonl"),
    evalDir("extraction_venues.jsonl"),
  );
  manifest.write(status);
  console.log(
    `Venues: ${cached.length}/${venues.length} extracted (${manifest.counts.venues_extraction_failed} failed, ${manifest.counts.venues_zero_rooms} with no rooms). Rooms: ${rooms.length}. xAI spend: $${budget.spent.toFixed(2)} of $${budget.cap}.`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
