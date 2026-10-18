/**
 * Schema-constrained extraction tier.
 *
 * Runs only when a venue clearly hosts private events but publishes the
 * details in prose the regex pass can't match ("our upstairs room comfortably
 * hosts parties of thirty"). Results are labeled `ai_extracted` — a distinct
 * tier, never merged into `verified` or `unverified` — because the number was
 * inferred from the venue's own words rather than matched verbatim.
 *
 * Uses xAI's `response_format: json_schema` with `strict: true` (verified
 * against the current xAI structured-outputs docs) so the model cannot return
 * prose, extra keys, or a differently-shaped object. The API is
 * OpenAI-compatible, called over plain fetch to avoid adding an SDK for one
 * request shape.
 */

import {
  MIN_SUCCESSFUL_READS,
  SELF_CONSISTENCY_K,
  SELF_CONSISTENCY_TEMPERATURE,
  xaiModel,
} from "@/lib/discovery/extraction-config";
import { aggregateReads, type AggregatedRoom, type ReadRoom } from "@/lib/discovery/features";
import { isGrounded } from "@/lib/discovery/grounding";
import { normalizeStyle, type RoomStyleLabel } from "@/lib/discovery/room-normalize";
import { CHUNK_SEPARATOR } from "@/lib/discovery/scraper";

const XAI_ENDPOINT = "https://api.x.ai/v1/chat/completions";
const XAI_TIMEOUT_MS = 45_000;

// Only the leading slice of page text is sent, to bound token spend. Because
// it is a leading slice, what comes first matters: see buildLlmInput.
export const MAX_TEXT_CHARS = 12_000;

export type LlmExtractedRoom = {
  roomName: string;
  maxCapacity: number;
  minCapacity: number | null;
  /** Seated or standing figure, when the page says which. */
  style?: RoomStyleLabel;
  /** Share of the k reads agreeing with this capacity (±10%); see features.ts. */
  selfConsistency?: number | null;
  /** This room's capacity in each successful read (null where a read didn't return it). */
  reads?: Array<number | null>;
  /**
   * The page sentence the model cited for this capacity. Always present on
   * rooms returned by extractPrivateDiningWithLlm (rooms whose quote fails the
   * grounding check are dropped); optional only for hand-built extractions.
   */
  evidenceQuote?: string;
};

export type LlmExtraction = {
  rooms: LlmExtractedRoom[];
  minSpendUsd: number | null;
  /** The sentence cited for minSpendUsd; null when no minimum spend was kept. */
  minSpendEvidence?: string | null;
  dietaryNotes: string | null;
  hostsPrivateEvents: boolean;
  /** Rooms the model returned whose evidence failed the grounding check — a hallucination proxy for evaluation. */
  rejectedCount?: number;
  /** True when a minimum spend was returned but its evidence failed the grounding check. */
  minSpendRejected?: boolean;
  /** Every room across the reads, grounded or not — the training data's unit (one row each). */
  aggregatedRooms?: AggregatedRoom[];
  /** Reads that returned a parseable answer, of the k attempted. */
  successfulReads?: number;
  /** The exact text the model read (after ordering and truncation). */
  inputText?: string;
};

const EXTRACTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["hostsPrivateEvents", "rooms", "minSpendUsd", "minSpendEvidence", "dietaryNotes"],
  properties: {
    hostsPrivateEvents: {
      type: "boolean",
      description: "True only if the page states this venue hosts private events or group dining.",
    },
    rooms: {
      type: "array",
      description:
        "One entry per named private room or event space with a stated or clearly implied guest capacity. Empty if the page states no capacity at all.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["roomName", "style", "maxCapacity", "minCapacity", "evidenceQuote"],
        properties: {
          roomName: {
            type: "string",
            description:
              'The room\'s name as written on the page. A whole-venue buyout is "Full buyout"; rooms that combine are listed separately and again as "A+B".',
          },
          style: {
            type: "string",
            enum: ["seated", "standing", "unspecified"],
            description:
              "seated or standing (reception) when the page says which; a room with both figures is returned twice, once per style.",
          },
          maxCapacity: { type: "integer", description: "Maximum guests this room holds (the upper bound of a range)." },
          minCapacity: {
            type: ["integer", "null"],
            description: "Minimum guests (the lower bound of a range), or null if not stated.",
          },
          evidenceQuote: {
            type: "string",
            description: "The exact sentence from the page that states this room's capacity, copied verbatim.",
          },
        },
      },
    },
    minSpendUsd: {
      type: ["integer", "null"],
      description: "Minimum spend or food-and-beverage minimum in USD, or null if not stated.",
    },
    minSpendEvidence: {
      type: ["string", "null"],
      description: "The exact sentence from the page that states the minimum spend, copied verbatim, or null.",
    },
    dietaryNotes: {
      type: ["string", "null"],
      description: "Short summary of dietary accommodations stated on the page, or null if none are mentioned.",
    },
  },
} as const;

const SYSTEM_PROMPT = [
  "You extract private-dining facts from restaurant and venue web pages for an event planner.",
  "Report only what the page actually states. Never estimate, infer from venue size, or fill gaps with typical values.",
  "If the page does not state a capacity, return an empty rooms array rather than guessing a number.",
  "A number written for a different purpose (street address, price, year, seat count of the whole restaurant) is not a private room capacity.",
  "For each room, copy the exact sentence from the page that states its capacity into evidenceQuote.",
  "If a room has separate seated and standing capacities, return it twice, once per style.",
  "Likewise copy the exact sentence stating the minimum spend into minSpendEvidence, or null if there is none.",
].join(" ");

const RETRY_BACKOFF_MS = 1_000;

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Keeps only what the page itself supports: each room's evidenceQuote must be
 * a verbatim sentence of the text the model was given and must state the
 * room's capacity (see grounding.ts [P3]); the same for minimum spend.
 */
export function groundExtraction(parsed: RawLlmExtraction, inputText: string): LlmExtraction {
  // `strict` guarantees the shape, not the semantics — a hallucinated
  // 900-person "private room" for a 40-seat restaurant is still shaped
  // correctly, so implausible figures are dropped here.
  const plausible = (parsed.rooms ?? []).filter(
    (room) =>
      Number.isInteger(room.maxCapacity) && room.maxCapacity > 0 && room.maxCapacity <= 5000 && room.roomName?.trim()
  );
  const rooms = plausible
    .filter((room) => isGrounded(room.evidenceQuote, inputText, room.maxCapacity))
    // A minimum that isn't a positive integer at or below the maximum is noise.
    .map((room) => ({
      ...room,
      minCapacity:
        Number.isInteger(room.minCapacity) && room.minCapacity! > 0 && room.minCapacity! <= room.maxCapacity
          ? room.minCapacity
          : null,
    }));

  const rawMinSpend = Number.isInteger(parsed.minSpendUsd) && (parsed.minSpendUsd ?? 0) > 0 ? parsed.minSpendUsd : null;
  const minSpendGrounded = rawMinSpend != null && isGrounded(parsed.minSpendEvidence, inputText, rawMinSpend);

  return {
    rooms,
    minSpendUsd: minSpendGrounded ? rawMinSpend : null,
    minSpendEvidence: minSpendGrounded ? (parsed.minSpendEvidence ?? null) : null,
    dietaryNotes: parsed.dietaryNotes?.trim() || null,
    hostsPrivateEvents: Boolean(parsed.hostsPrivateEvents),
    rejectedCount: plausible.length - rooms.length,
    minSpendRejected: rawMinSpend != null && !minSpendGrounded,
  };
}

/**
 * Orders the model's input so the private-dining page is read first, then the
 * rest of the site (homepage etc.), and truncates the result.
 *
 * combinedText leads with the homepage. On a long homepage the slice used to
 * end before the private-events page even started, so the one page that
 * states room capacities was never sent — the model then either found nothing
 * or read the main dining room's seat count instead.
 */
export function buildLlmInput(privateDiningText: string, combinedText: string, maxChars = MAX_TEXT_CHARS): string {
  const lead = privateDiningText.trim();
  if (!lead) return combinedText.slice(0, maxChars);

  // Page texts never contain the separator (whitespace is collapsed), so this
  // removes exactly the private-dining pages rather than fuzzy-matching text.
  const leadPages = new Set(lead.split(CHUNK_SEPARATOR));
  const rest = combinedText
    .split(CHUNK_SEPARATOR)
    .filter((page) => page && !leadPages.has(page))
    .join(CHUNK_SEPARATOR);

  return (rest ? `${lead}${CHUNK_SEPARATOR}${rest}` : lead).slice(0, maxChars);
}

export function isLlmExtractionConfigured(): boolean {
  return Boolean(process.env.XAI_API_KEY);
}

/** The model's answer as returned, before grounding — cached by the eval harness. */
export type RawLlmExtraction = LlmExtraction & { minSpendEvidence?: string | null };

/** Token usage of one call, as xAI reports it (OpenAI-compatible). */
export type XaiUsage = { model: string; promptTokens: number; completionTokens: number; reasoningTokens: number };

export type LlmRequestOptions = {
  temperature?: number;
  /** Called once per successful HTTP response, for spend tracking. */
  onUsage?: (usage: XaiUsage) => void;
};

/**
 * Sends `input` to the model and returns its parsed, schema-shaped answer
 * without grounding it. One retry after 1 s for 429/5xx; null otherwise.
 */
export async function requestLlmExtraction(
  venueName: string,
  input: string,
  options: LlmRequestOptions = {}
): Promise<RawLlmExtraction | null> {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey || !input.trim()) return null;

  const model = xaiModel();
  const body = JSON.stringify({
    model,
    temperature: options.temperature ?? 0,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: `Venue: ${venueName}\n\nPage text:\n${input}`,
      },
    ],
    response_format: {
      type: "json_schema",
      json_schema: { name: "private_dining_extraction", strict: true, schema: EXTRACTION_SCHEMA },
    },
  });

  // One retry, after a 1 s backoff, for rate limiting and server errors only;
  // anything else (4xx, timeout, network failure) returns null as before.
  for (let attempt = 1; attempt <= 2; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), XAI_TIMEOUT_MS);

    try {
      const res = await fetch(XAI_ENDPOINT, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body,
        signal: controller.signal,
      });

      if (!res.ok) {
        if (attempt === 1 && isRetryableStatus(res.status)) {
          clearTimeout(timeout);
          await sleep(RETRY_BACKOFF_MS);
          continue;
        }
        console.error(`xAI extraction failed for ${venueName}: ${res.status}`);
        return null;
      }

      const payload = (await res.json()) as {
        model?: string;
        choices?: Array<{ message?: { content?: string } }>;
        usage?: {
          prompt_tokens?: number;
          completion_tokens?: number;
          completion_tokens_details?: { reasoning_tokens?: number };
        };
      };
      options.onUsage?.({
        model: payload.model ?? model,
        promptTokens: payload.usage?.prompt_tokens ?? 0,
        completionTokens: payload.usage?.completion_tokens ?? 0,
        reasoningTokens: payload.usage?.completion_tokens_details?.reasoning_tokens ?? 0,
      });
      const content = payload.choices?.[0]?.message?.content;
      if (!content) return null;

      return JSON.parse(content) as RawLlmExtraction;
    } catch (err) {
      console.error(`xAI extraction threw for ${venueName}:`, err);
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  return null;
}

/**
 * One read's rooms with their grounding result kept (not filtered), so the
 * confidence model can learn from ungrounded rooms too. Implausible figures
 * are still dropped, as in groundExtraction.
 */
export function readRooms(parsed: RawLlmExtraction, inputText: string): ReadRoom[] {
  return (parsed.rooms ?? [])
    .filter(
      (room) =>
        Number.isInteger(room.maxCapacity) && room.maxCapacity > 0 && room.maxCapacity <= 5000 && room.roomName?.trim()
    )
    .map((room) => ({
      roomName: room.roomName.trim(),
      style: normalizeStyle(room.style),
      maxCapacity: room.maxCapacity,
      minCapacity:
        Number.isInteger(room.minCapacity) && room.minCapacity! > 0 && room.minCapacity! <= room.maxCapacity
          ? room.minCapacity
          : null,
      evidenceQuote: room.evidenceQuote ?? "",
      grounded: isGrounded(room.evidenceQuote, inputText, room.maxCapacity),
    }));
}

export type MultiReadOptions = LlmRequestOptions & { k?: number };

/**
 * Self-consistency extraction [P7, P8]: k independent reads of the same input
 * at SELF_CONSISTENCY_TEMPERATURE, run in parallel, merged per room. Failed
 * reads are retried once if fewer than two succeeded. Returns null when no
 * read succeeded.
 *
 * `rooms` keeps the existing contract — only grounded rooms, each at its modal
 * capacity — so the trust table is unchanged; `aggregatedRooms` carries every
 * room with its self-consistency for scoring and for the training data.
 */
export async function extractWithSelfConsistency(
  venueName: string,
  input: string,
  options: MultiReadOptions = {}
): Promise<LlmExtraction | null> {
  const k = options.k ?? SELF_CONSISTENCY_K;
  const read = () =>
    requestLlmExtraction(venueName, input, {
      temperature: options.temperature ?? SELF_CONSISTENCY_TEMPERATURE,
      onUsage: options.onUsage,
    });

  const answers = await Promise.all(Array.from({ length: k }, read));
  if (answers.filter(Boolean).length < MIN_SUCCESSFUL_READS) {
    await Promise.all(
      answers.map(async (answer, i) => {
        if (!answer) answers[i] = await read();
      })
    );
  }
  const successful = answers.filter((a): a is RawLlmExtraction => a != null);
  if (successful.length === 0) return null;

  const aggregatedRooms = aggregateReads(answers.map((a) => (a ? readRooms(a, input) : null)));
  const grounded = aggregatedRooms.filter((r) => r.grounded);

  const firstSpend = successful.map((a) => groundExtraction(a, input)).find((g) => g.minSpendUsd != null);
  const hostsVotes = successful.filter((a) => a.hostsPrivateEvents).length;

  return {
    rooms: grounded.map((r) => ({
      roomName: r.roomName,
      maxCapacity: r.capacity,
      minCapacity: r.minCapacity != null && r.minCapacity <= r.capacity ? r.minCapacity : null,
      evidenceQuote: r.evidenceQuote,
      style: r.style,
      selfConsistency: r.selfConsistency,
      reads: r.reads,
    })),
    minSpendUsd: firstSpend?.minSpendUsd ?? null,
    minSpendEvidence: firstSpend?.minSpendEvidence ?? null,
    dietaryNotes: successful.map((a) => a.dietaryNotes?.trim()).find(Boolean) ?? null,
    hostsPrivateEvents: hostsVotes * 2 > successful.length,
    rejectedCount: aggregatedRooms.length - grounded.length,
    minSpendRejected: successful.some((a) => groundExtraction(a, input).minSpendRejected) && !firstSpend,
    aggregatedRooms,
    successfulReads: successful.length,
    inputText: input,
  };
}

/** The app's extraction: private-dining text first, then k self-consistent reads. */
export async function extractPrivateDiningWithLlm(
  venueName: string,
  pageText: string,
  privateDiningText = "",
  options: MultiReadOptions = {}
): Promise<LlmExtraction | null> {
  if (!pageText.trim()) return null;
  const input = buildLlmInput(privateDiningText, pageText);
  return extractWithSelfConsistency(venueName, input, options);
}
