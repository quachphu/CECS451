/**
 * Normalization rules shared by the page reader, the support-draft labels,
 * validation, review ingest and the train/test tables, so a room is named and
 * sized the same way wherever it is compared.
 *
 *   "30–40"                   → min 30, max 40
 *   "50 seated / 80 standing" → two rows, one per style
 *   full buyout               → room name "Full buyout"
 *   combinable rooms          → one row per room plus "A+B"
 *   number words              → digits
 */

export type RoomStyleLabel = "seated" | "standing" | "unspecified";

const SMALL: Record<string, number> = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
};

/** "one hundred and twenty" → 120, "two thousand" → 2000, "a hundred" → 100; null if not a number phrase. */
export function wordsToNumber(phrase: string): number | null {
  const words = phrase
    .toLowerCase()
    .replace(/-/g, " ")
    .split(/\s+/)
    .filter((w) => w && w !== "and");
  if (words.length === 0) return null;
  let total = 0;
  let current = 0;
  let seen = false;
  for (const [i, w] of words.entries()) {
    if (w === "a" && i === 0) {
      current = 1;
      continue;
    }
    if (w in SMALL) {
      current += SMALL[w];
      seen = true;
    } else if (w === "hundred") {
      current = (current || 1) * 100;
      seen = true;
    } else if (w === "thousand") {
      total += (current || 1) * 1000;
      current = 0;
      seen = true;
    } else return null;
  }
  return seen ? total + current : null;
}

const NUMBER_WORD =
  "(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|and|a)";
const WORD_RUN = new RegExp(`\\b${NUMBER_WORD}(?:[\\s-]+${NUMBER_WORD})*\\b`, "gi");

/** Replaces spelled-out numbers with digits: "seats forty-five guests" → "seats 45 guests". */
export function numberWordsToDigits(text: string): string {
  return text.replace(WORD_RUN, (run) => {
    const trimmed = run.trim();
    // Lone "a"/"and" are words, not numbers.
    if (/^(a|and)$/i.test(trimmed)) return run;
    const value = wordsToNumber(trimmed);
    return value == null ? run : String(value);
  });
}

/**
 * Parses a capacity as written by a person or a page: "40", "1,200",
 * "30-40", "30 to 40", "up to 40", "forty", "thirty to forty". Returns null
 * when no positive number is found.
 */
export function parseCapacityText(raw: string | number | null | undefined): { min: number | null; max: number } | null {
  if (raw == null) return null;
  if (typeof raw === "number") return Number.isFinite(raw) && raw > 0 ? { min: null, max: Math.round(raw) } : null;
  const text = numberWordsToDigits(raw.trim()).replace(/(\d),(\d{3})\b/g, "$1$2");
  const nums = Array.from(text.matchAll(/\d+(?:\.\d+)?/g), (m) => Math.round(Number(m[0]))).filter((n) => n > 0);
  if (nums.length === 0) return null;
  const isRange = nums.length >= 2 && /\d\s*(?:-|–|—|to|through)\s*\d/i.test(text);
  if (isRange) {
    const [a, b] = [nums[0], nums[1]];
    return { min: Math.min(a, b), max: Math.max(a, b) };
  }
  return { min: null, max: nums[0] };
}

const BUYOUT =
  /\b(full|whole|entire|complete|total)[\s-]*(restaurant|venue|space|bar|property)?[\s-]*buy[\s-]*outs?\b|\bbuy[\s-]*outs?\b|\b(entire|whole) (restaurant|venue|space)\b|\bexclusive use\b/i;

export const FULL_BUYOUT = "Full buyout";

/**
 * Canonical display name: buyouts become "Full buyout"; combined rooms written
 * "A & B combined", "A and B (combined)", "A + B" become "A+B".
 */
export function canonicalRoomName(name: string): string {
  const trimmed = name.replace(/\s+/g, " ").trim();
  if (BUYOUT.test(trimmed)) return FULL_BUYOUT;
  const combined = /\bcombined\b|\btogether\b|\s\+\s|^.+\+.+$/i.test(trimmed);
  if (combined) {
    const parts = trimmed
      .replace(/\(?\b(combined|together)\b\)?/gi, "")
      .split(/\s*(?:\+|&|\band\b|,)\s*/i)
      .map((p) => p.trim())
      .filter(Boolean);
    if (parts.length >= 2) return parts.join("+");
  }
  return trimmed;
}

const NAME_STOPWORDS = new Set(["the", "room", "rooms", "private", "a", "an", "our"]);

/** Matching key: lowercase, without "the"/"room"/"private", punctuation collapsed. */
export function normalizeRoomKey(name: string): string {
  return canonicalRoomName(name)
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/\+/g, " plus ")
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((w) => w && !NAME_STOPWORDS.has(w))
    .join(" ");
}

/** Token Jaccard similarity of two room names after normalizeRoomKey. */
export function roomNameJaccard(a: string, b: string): number {
  const ta = new Set(normalizeRoomKey(a).split(" ").filter(Boolean));
  const tb = new Set(normalizeRoomKey(b).split(" ").filter(Boolean));
  if (ta.size === 0 && tb.size === 0) return 1;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}

export function normalizeStyle(raw: string | null | undefined): RoomStyleLabel {
  const s = (raw ?? "").toLowerCase();
  if (/seat|banquet|dinner|sit/.test(s)) return "seated";
  if (/stand|reception|cocktail|mingl/.test(s)) return "standing";
  return "unspecified";
}

/** A row-level room as extractions and labels are compared. */
export type NormalizedRoom = {
  roomName: string;
  style: RoomStyleLabel;
  max: number;
  min: number | null;
};

/**
 * Applies the rules to a label room that may carry both a seated and a
 * standing figure: one row per stated figure, with the name canonicalised.
 */
export function splitLabelRoom(room: {
  roomName: string;
  seatedMax?: number | null;
  standingMax?: number | null;
  min?: number | null;
}): NormalizedRoom[] {
  const name = canonicalRoomName(room.roomName);
  const min = room.min != null && room.min > 0 ? room.min : null;
  const rows: NormalizedRoom[] = [];
  if (room.seatedMax != null && room.seatedMax > 0)
    rows.push({ roomName: name, style: "seated", max: room.seatedMax, min });
  if (room.standingMax != null && room.standingMax > 0)
    rows.push({ roomName: name, style: "standing", max: room.standingMax, min });
  return rows;
}
