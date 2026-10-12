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

import { isGrounded } from "@/lib/discovery/grounding";
import { CHUNK_SEPARATOR } from "@/lib/discovery/scraper";

const XAI_ENDPOINT = "https://api.x.ai/v1/chat/completions";
const XAI_MODEL = "grok-4.5";
const XAI_TIMEOUT_MS = 45_000;

// Only the leading slice of page text is sent, to bound token spend. Because
// it is a leading slice, what comes first matters: see buildLlmInput.
export const MAX_TEXT_CHARS = 12_000;

export type LlmExtractedRoom = {
  roomName: string;
  maxCapacity: number;
  minCapacity: number | null;
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
        required: ["roomName", "maxCapacity", "minCapacity", "evidenceQuote"],
        properties: {
          roomName: { type: "string", description: "The room's name as written on the page." },
          maxCapacity: { type: "integer", description: "Maximum guests this room holds." },
          minCapacity: { type: ["integer", "null"], description: "Minimum guests, or null if not stated." },
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
    (room) => Number.isInteger(room.maxCapacity) && room.maxCapacity > 0 && room.maxCapacity <= 5000 && room.roomName?.trim()
  );
  const rooms = plausible.filter((room) => isGrounded(room.evidenceQuote, inputText, room.maxCapacity));

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

/**
 * Sends `input` to the model and returns its parsed, schema-shaped answer
 * without grounding it. One retry after 1 s for 429/5xx; null otherwise.
 */
export async function requestLlmExtraction(venueName: string, input: string): Promise<RawLlmExtraction | null> {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey || !input.trim()) return null;

  const body = JSON.stringify({
    model: XAI_MODEL,
    temperature: 0,
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

      const payload = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
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

export async function extractPrivateDiningWithLlm(
  venueName: string,
  pageText: string,
  privateDiningText = ""
): Promise<LlmExtraction | null> {
  if (!pageText.trim()) return null;
  const input = buildLlmInput(privateDiningText, pageText);
  const raw = await requestLlmExtraction(venueName, input);
  return raw ? groundExtraction(raw, input) : null;
}
