import type { CandidateVenue } from "@/lib/discovery/places";
import { scoreCandidateConfidence, trustFromConfidence, type ConfidenceSource } from "@/lib/discovery/confidence";
import { encodeCandidateFeatures } from "@/lib/discovery/features";
import { findEvidenceUrl } from "@/lib/discovery/grounding";
import { type LlmExtractedRoom, type LlmExtraction } from "@/lib/discovery/llm-extract";
import {
  clusterNumberHits,
  extractPageNumberCandidates,
  MIN_PLAUSIBLE_CAPACITY,
  withinRelative,
  type CapacityCandidate,
  type NumberHit,
  type ScrapedSignals,
} from "@/lib/discovery/scraper";
import type { RoomStyle, TrustLevel } from "@/lib/supabase/types";

export type DraftRoom = {
  roomName: string;
  minCapacity?: number;
  maxCapacity: number;
  style: RoomStyle;
  capacityTrust: TrustLevel;
  notes?: string;
  /** True when maxCapacity is a category guess, not a figure read anywhere. */
  isEstimate: boolean;
  /** The page sentence that states this capacity, when there is one. */
  evidenceQuote: string | null;
  /** The page that sentence was read on. */
  evidenceUrl: string | null;
  /** P(capacity is right) from the trained model, scored at write time; null when unscored (see confidence.ts). */
  confidence: number | null;
  /** How the figure was obtained. */
  confidenceSource: ConfidenceSource;
  /** The candidate features `confidence` was computed from; persisted for refitting. */
  confidenceFeatures: Record<string, number> | null;
};

/** Model probability and trust label for a number already chosen for display. */
export function scorePageCapacity(
  signals: ScrapedSignals,
  room: LlmExtractedRoom | null,
  value: number,
  quote: string | null
): { confidence: number | null; capacityTrust: TrustLevel; features: Record<string, number> } {
  const features = featuresForDisplayed(signals, candidatesOf(signals), room, value, quote);
  const confidence = scoreCandidateConfidence(features);
  return {
    confidence,
    capacityTrust: confidence == null ? "unverified" : trustFromConfidence(confidence),
    features,
  };
}

function scored(
  room: Omit<DraftRoom, "confidence" | "confidenceSource" | "confidenceFeatures">,
  source: ConfidenceSource,
  features: Record<string, number> | null = null
): DraftRoom {
  const confidence = source === "estimate" ? null : scoreCandidateConfidence(features);
  return {
    ...room,
    capacityTrust: confidence == null ? room.capacityTrust : trustFromConfidence(confidence),
    confidence,
    confidenceSource: source,
    confidenceFeatures: features,
  };
}

export type VenueDraft = {
  placeSourceId: string;
  name: string;
  formattedAddress: string;
  lat: number;
  lng: number;
  category: string;
  website: string | null;
  phone: string | null;
  email: string | null;
  priceTier: string | null;
  priceTierTrust: TrustLevel;
  minSpendUsd: number | null;
  minSpendTrust: TrustLevel;
  description: string;
  sourceNote: string;
  rooms: DraftRoom[];
  imageUrl: string | null;
  menuUrl: string | null;
  menuTrust: TrustLevel;
  dietaryNotes: string | null;
  dietaryTrust: TrustLevel;
};

/**
 * How far two independent capacity reads may differ and still count as
 * agreeing. Venues describe the same room as "up to 60" and "seats 55"
 * routinely, so an exact-match requirement would flag normal paraphrasing as
 * a conflict; 20% is loose enough to absorb that and tight enough that 60 vs
 * 120 still surfaces as a real disagreement.
 */
const AGREEMENT_TOLERANCE = 0.2;

/** Source note for a venue whose robots.txt disallows its homepage (Step 7). */
export const ROBOTS_BLOCKED_NOTE = "Site asks crawlers not to read it — call the venue.";

/** Source note for a venue whose site couldn't be reached at all during discovery. */
export const SITE_UNREACHABLE_NOTE =
  "The venue's website couldn't be read during discovery, so private-dining availability and capacity are unconfirmed. Call the venue directly.";

function inferStyle(category: string): RoomStyle {
  const c = category.toLowerCase();
  if (c.includes("bar") || c.includes("night") || c.includes("club")) return "reception";
  if (c.includes("banquet") || c.includes("hotel") || c.includes("event")) return "either";
  return "either";
}

// Used only when no private-dining info could be scraped at all, so the
// required "capacity" field still has *something* to show — always paired
// with capacityTrust: 'unverified' and an explicit note, never presented
// as a confirmed number.
function estimateCapacityByCategory(category: string): number {
  const c = category.toLowerCase();
  if (c.includes("banquet")) return 150;
  if (c.includes("night") || c.includes("club")) return 120;
  if (c.includes("bar")) return 80;
  return 60; // restaurant / generic default
}

function priceLevelToTier(level: number | undefined): string | null {
  if (level == null) return null;
  return ["$", "$", "$$", "$$$", "$$$$"][level] ?? null;
}

/**
 * Cross-references the regex read of a page against the LLM read of the same
 * page. Two independent methods agreeing is stronger evidence than either
 * alone, so agreement earns `verified` — but disagreement is never silently
 * resolved by picking a winner. Both figures are surfaced and the label drops
 * to `likely` so the planner knows to check.
 */
export function capacitySpread(a: number, b: number): number {
  return Math.abs(a - b) / Math.max(a, b, 1);
}

function agreementNote(regexValue: number, llmValue: number): string {
  return `Two independent reads of the venue's page agree on capacity (page text: ${regexValue}, AI extraction: ${llmValue}).`;
}

function disagreementNote(regexValue: number, llmValue: number): string {
  return `Sources disagree — the page text reads as up to ${regexValue} guests, while AI extraction of the same page reads ${llmValue}. Confirm the real figure with the venue.`;
}

function normalizeRoomName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[’'".,()]/g, "")
    .replace(/\b(the|our|private)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sameRoom(hint: string | null, roomName: string): boolean {
  if (!hint) return false;
  const a = normalizeRoomName(hint);
  const b = normalizeRoomName(roomName);
  return a.length > 0 && b.length > 0 && (a === b || a.includes(b) || b.includes(a));
}

/** Prefer candidates read on a private-dining page, then the smaller figure. */
function byEvidenceThenSize(a: CapacityCandidate, b: CapacityCandidate): number {
  const pd = Number(Boolean(b.onPrivateDiningPage)) - Number(Boolean(a.onPrivateDiningPage));
  return pd !== 0 ? pd : a.value - b.value;
}

/**
 * Picks which regex candidate(s) become rooms when no grounded LLM read is
 * available: one room per distinct room name the page attached to a figure,
 * else the single smallest plausible figure.
 *
 * Never the largest: a homepage's "main dining room seats 180" next to a
 * private room's "holds 40" used to become a 180-guest private room.
 */
function pickRegexCandidates(candidates: CapacityCandidate[]): CapacityCandidate[] {
  const hinted = candidates.filter((c) => c.roomHint);
  if (hinted.length === 0) return [[...candidates].sort(byEvidenceThenSize)[0]];

  const byRoom = new Map<string, CapacityCandidate>();
  for (const c of [...hinted].sort(byEvidenceThenSize)) {
    const key = normalizeRoomName(c.roomHint!);
    if (!byRoom.has(key)) byRoom.set(key, c);
  }
  return Array.from(byRoom.values());
}

/**
 * Whether a candidate was read on the private-dining page itself. Candidates
 * from hand-built signals carry no page information and count as on it, which
 * keeps their behaviour unchanged.
 */
function onPrivateDiningPage(c: CapacityCandidate): boolean {
  return c.onPrivateDiningPage !== false;
}

/** Candidates from hand-built signals (tests, eval baselines) that only carry capacityNumbers. */
function candidatesOf(signals: ScrapedSignals): CapacityCandidate[] {
  const raw =
    signals.capacityCandidates ??
    signals.capacityNumbers.map((value) => ({ value, context: "", sentence: "", roomHint: null }));
  return raw.filter((c) => c.value >= MIN_PLAUSIBLE_CAPACITY);
}

/** A grounded quote names this integer, and not a longer number that merely contains its digits. */
function quoteHas(quote: string | null | undefined, value: number): boolean {
  return Boolean(quote && new RegExp(`(?<!\\d)${value}(?!\\d)`).test(quote));
}

/** Reads within 10% of `value`. A room with no saved reads counts its own figure as one vote. */
function votesFor(room: LlmExtractedRoom | null, value: number): number {
  const reads = (room?.reads ?? []).filter((n): n is number => typeof n === "number");
  if (reads.length > 0) return reads.filter((n) => withinRelative(n, value, 0.1)).length;
  return room && withinRelative(room.maxCapacity, value, 0.1) ? 1 : 0;
}

function regexHits(candidates: CapacityCandidate[], value: number): boolean {
  return candidates.some((c) => withinRelative(c.value, value, 0.03));
}

/**
 * Which number is displayed: llm votes + a grounded quote + a regex hit.
 * Ties keep the regex figure, the number printed on the page.
 */
function pickDisplayed(
  room: LlmExtractedRoom | null,
  candidates: CapacityCandidate[],
  quote: string | null,
  values: Array<number | null | undefined>
): number {
  const unique = [...new Set(values.filter((v): v is number => typeof v === "number" && v > 0))];
  let best = unique[0] ?? room?.maxCapacity ?? 0;
  let bestTotal = -1;
  let bestRegex = false;
  for (const value of unique) {
    const regex = regexHits(candidates, value);
    const total = votesFor(room, value) + (quoteHas(quote, value) ? 1 : 0) + (regex ? 1 : 0);
    if (total > bestTotal || (total === bestTotal && regex && !bestRegex)) {
      best = value;
      bestTotal = total;
      bestRegex = regex;
    }
  }
  return best;
}

function pageClusters(signals: ScrapedSignals): { value: number; cluster: NumberHit[] }[] {
  const pages = signals.pages?.length
    ? signals.pages.map((p) => ({ text: p.text, privateDining: p.privateDining }))
    : signals.combinedText
      ? [{ text: signals.combinedText, privateDining: signals.privateDiningPageFound }]
      : [];
  const ranked = clusterNumberHits(extractPageNumberCandidates(pages))
    .map((cluster) => ({
      cluster,
      value: cluster.find((hit) => hit.regexHit)?.value ?? cluster[0].value,
    }))
    .sort((a, b) => b.value - a.value);
  return ranked;
}

/** Candidate-model features for the number this room displays. */
function featuresForDisplayed(
  signals: ScrapedSignals,
  candidates: CapacityCandidate[],
  room: LlmExtractedRoom | null,
  value: number,
  quote: string | null
): Record<string, number> {
  const ranked = pageClusters(signals);
  const match = ranked.find((item) => withinRelative(item.value, value, 0.03));
  const flagged = (flag: keyof NumberHit) => Boolean(match?.cluster.some((hit) => hit[flag]));
  const onPage =
    match != null
      ? flagged("onPrivatePage")
      : candidates.some(
          (c) => withinRelative(c.value, value, 0.03) && signals.privateDiningPageFound && onPrivateDiningPage(c)
        );
  return encodeCandidateFeatures({
    llmVotes: votesFor(room, value),
    regexHit: regexHits(candidates, value) || flagged("regexHit"),
    inGroundedQuote: quoteHas(quote, value),
    roomWordNear: flagged("roomWordNear"),
    capacityVerbNear: flagged("capacityVerbNear"),
    reservationPhraseNear: flagged("reservationPhraseNear"),
    wholeVenuePhraseNear: flagged("wholeVenuePhraseNear"),
    looksLikeJunk: flagged("looksLikeJunk"),
    onPrivatePage: onPage,
    valueRank: match ? ranked.indexOf(match) + 1 : 1,
    logValue: Math.log(value),
    nCandidates: Math.max(ranked.length, 1),
  });
}

/**
 * The trust table (NOTES-ai-core.md, Step 2f):
 *  - a regex candidate and a grounded LLM room agree within 20% → verified,
 *    capacity = the regex figure, evidence = the LLM's quote;
 *  - they describe the same room but disagree by more → likely, both figures
 *    in the note, the verbatim regex figure displayed;
 *  - a grounded LLM room with no regex counterpart → ai_extracted;
 *  - regex candidates only, on a private-dining page → likely (a pattern match
 *    alone no longer earns verified); without a private-dining page → unverified.
 */
function roomsFromEvidence(signals: ScrapedSignals, llm: LlmExtraction | null, style: RoomStyle): DraftRoom[] | null {
  const candidates = candidatesOf(signals);
  const pages = signals.pages ?? [];
  const llmRooms: LlmExtractedRoom[] = llm?.rooms ?? [];

  if (llmRooms.length > 0) {
    return llmRooms.map((room): DraftRoom => {
      const evidenceUrl = findEvidenceUrl(room.evidenceQuote, pages);
      // Only a figure about this room can corroborate it: one read on the
      // private-dining page, or one the page itself attached this room's name
      // to. A homepage's "main dining room seats 45" landing within 20% of a
      // private room's 40 is a coincidence, not a second read.
      const comparable = candidates.filter((c) => onPrivateDiningPage(c) || sameRoom(c.roomHint, room.roomName));
      const agreeing = comparable
        .filter((c) => capacitySpread(c.value, room.maxCapacity) <= AGREEMENT_TOLERANCE)
        .sort(
          (a, b) =>
            Number(sameRoom(b.roomHint, room.roomName)) - Number(sameRoom(a.roomHint, room.roomName)) ||
            capacitySpread(a.value, room.maxCapacity) - capacitySpread(b.value, room.maxCapacity)
        )[0];

      if (agreeing) {
        const quote = room.evidenceQuote ?? (agreeing.sentence || null);
        const displayed = pickDisplayed(room, comparable, quote, [agreeing.value, room.maxCapacity, ...(room.reads ?? [])]);
        return scored(
          {
            roomName: room.roomName,
            minCapacity: room.minCapacity != null && room.minCapacity <= displayed ? room.minCapacity : undefined,
            maxCapacity: displayed,
            style,
            capacityTrust: "verified",
            notes: agreementNote(agreeing.value, room.maxCapacity),
            isEstimate: false,
            evidenceQuote: quote,
            evidenceUrl: evidenceUrl ?? agreeing.url ?? null,
          },
          "both",
          featuresForDisplayed(signals, comparable, room, displayed, quote)
        );
      }

      // The same room read two ways: matched by name, or — when the page has a
      // single room — the regex's own pick for that room.
      // Only figures from the private-dining page are eligible for the
      // single-room fallback — otherwise a homepage's "seats 180" would be
      // shown for a private room the model correctly read as 40.
      const privatePageCandidates = comparable.filter(onPrivateDiningPage);
      const conflicting =
        comparable.find((c) => sameRoom(c.roomHint, room.roomName)) ??
        (llmRooms.length === 1 && privatePageCandidates.length > 0
          ? pickRegexCandidates(privatePageCandidates)[0]
          : undefined);

      if (conflicting) {
        const quote = room.evidenceQuote ?? (conflicting.sentence || null);
        const displayed = pickDisplayed(room, comparable, quote, [conflicting.value, room.maxCapacity, ...(room.reads ?? [])]);
        return scored(
          {
            roomName: room.roomName,
            maxCapacity: displayed,
            style,
            capacityTrust: "likely",
            notes: disagreementNote(conflicting.value, room.maxCapacity),
            isEstimate: false,
            evidenceQuote: quote,
            evidenceUrl: conflicting.url ?? null,
          },
          "both",
          featuresForDisplayed(signals, comparable, room, displayed, quote)
        );
      }

      const quote = room.evidenceQuote ?? null;
      const displayed = pickDisplayed(room, comparable, quote, [room.maxCapacity, ...(room.reads ?? [])]);
      return scored(
        {
          roomName: room.roomName,
          minCapacity: room.minCapacity ?? undefined,
          maxCapacity: displayed,
          style,
          capacityTrust: "ai_extracted",
          notes:
            "Read from the venue's own page by AI because the page states capacity in prose rather than a standard format. Confirm before booking.",
          isEstimate: false,
          evidenceQuote: quote,
          evidenceUrl,
        },
        "llm",
        featuresForDisplayed(signals, comparable, room, displayed, quote)
      );
    });
  }

  if (candidates.length > 0) {
    const picked = pickRegexCandidates(candidates);
    return picked.map(
      (c): DraftRoom =>
        scored(
          {
            roomName: c.roomHint ?? "Private Dining / Event Space",
            maxCapacity: c.value,
            style,
            // `likely` needs the figure to come from the private-dining page
            // itself; the same pattern on the homepage usually describes the
            // main dining room.
            capacityTrust: signals.privateDiningPageFound && onPrivateDiningPage(c) ? "likely" : "unverified",
            notes:
              signals.privateDiningPageFound && onPrivateDiningPage(c)
                ? "Capacity figure read from the venue's own private-dining/events page by pattern match, not confirmed by a second independent read — confirm before booking."
                : "Capacity figure appears on the venue's site but not on a private-dining page, so it may not describe a private room — call to confirm.",
            isEstimate: false,
            evidenceQuote: c.sentence || null,
            evidenceUrl: c.url ?? null,
          },
          "regex",
          featuresForDisplayed(signals, candidates, null, c.value, c.sentence || null)
        )
    );
  }

  return null;
}

/**
 * Turns a discovered candidate + whatever the scraper found into a
 * database-ready draft, with every confidence field derived from what was
 * actually observed rather than assumed. This is the single place that
 * decides verified vs. likely vs. ai_extracted vs. unverified.
 */
export function buildVenueDraft(
  candidate: CandidateVenue,
  signals: ScrapedSignals | null,
  llm: LlmExtraction | null = null
): VenueDraft {
  const style = inferStyle(candidate.category);
  const priceTier = priceLevelToTier(candidate.priceLevelGoogle);

  if (!signals || signals.robotsBlocked || signals.siteUnreachable) {
    const robotsBlocked = Boolean(signals?.robotsBlocked);
    const unreachable = Boolean(signals?.siteUnreachable);
    return {
      placeSourceId: candidate.placeSourceId,
      name: candidate.name,
      formattedAddress: candidate.formattedAddress,
      lat: candidate.lat,
      lng: candidate.lng,
      category: candidate.category,
      // Kept when robots.txt is what stopped us — the planner can still visit it.
      website: robotsBlocked || unreachable ? (candidate.website ?? null) : null,
      phone: candidate.phone ?? null,
      email: null,
      priceTier,
      priceTierTrust: priceTier ? "likely" : "unverified",
      minSpendUsd: null,
      minSpendTrust: "unverified",
      description: `${candidate.name} — discovered near your search location.`,
      sourceNote: robotsBlocked
        ? ROBOTS_BLOCKED_NOTE
        : unreachable
          ? SITE_UNREACHABLE_NOTE
          : "No website found for this venue during discovery, so private-dining availability and capacity are unconfirmed. Call the venue directly.",
      rooms: [
        scored(
          {
            roomName: "Capacity unconfirmed",
            maxCapacity: estimateCapacityByCategory(candidate.category),
            style,
            capacityTrust: "unverified",
            notes: "Estimated from venue category only — no source to confirm against.",
            isEstimate: true,
            evidenceQuote: null,
            evidenceUrl: null,
          },
          "estimate"
        ),
      ],
      // Google Places can have a photo for a venue even with no website
      // on file — only Overpass-sourced candidates (no Google key) truly
      // have zero photo options here.
      imageUrl: candidate.photoUrl ?? null,
      menuUrl: null,
      menuTrust: "unverified",
      dietaryNotes: null,
      dietaryTrust: "unverified",
    };
  }

  const hasCapacityNumbers = candidatesOf(signals).length > 0;

  const rooms: DraftRoom[] = roomsFromEvidence(signals, llm, style) ?? [
    scored(
      {
        roomName: signals.privateDiningPageFound
          ? "Private events available (capacity unpublished)"
          : "Capacity unconfirmed",
        maxCapacity: estimateCapacityByCategory(candidate.category),
        style,
        capacityTrust: signals.privateDiningPageFound ? "likely" : "unverified",
        notes: signals.privateDiningPageFound
          ? "Venue confirms private events but does not publish a specific capacity number — call to confirm fit."
          : "Estimated from venue category only — no private-dining page found to confirm against.",
        isEstimate: true,
        evidenceQuote: null,
        evidenceUrl: null,
      },
      "estimate"
    ),
  ];

  const regexMinSpend = signals.minSpendUsd.length > 0 ? Math.min(...signals.minSpendUsd) : null;
  const minSpendUsd = regexMinSpend ?? llm?.minSpendUsd ?? null;
  // A "minimum spend" phrase only counts as the venue's published private-event
  // terms when it was read on a private-dining page; the same phrase elsewhere
  // on a site (a bar's happy-hour promo, a gift-card page) is a real phrase
  // but not evidence about private events.
  const minSpendTrust: TrustLevel =
    regexMinSpend != null
      ? signals.privateDiningPageFound
        ? "verified"
        : "likely"
      : llm?.minSpendUsd != null
        ? "ai_extracted"
        : "unverified";

  // Regex-matched phrases come straight off the venue's page, so they're
  // `likely` — the phrase is real, but "vegan" appearing near private-dining
  // copy isn't a commitment to cater a vegan event. An LLM summary of the same
  // page is labeled by its method instead.
  const dietaryNotes = signals.dietaryNotes ?? llm?.dietaryNotes ?? null;
  const dietaryTrust: TrustLevel = signals.dietaryNotes ? "likely" : llm?.dietaryNotes ? "ai_extracted" : "unverified";

  const sourceNoteParts = [
    `Auto-discovered and cross-checked against ${signals.scrapedUrls.length} page(s) of the venue's own website.`,
    signals.privateDiningPageFound
      ? hasCapacityNumbers
        ? "A dedicated private-dining/events page was found with an explicit capacity figure."
        : "A private-events page was found but it doesn't publish a specific capacity number."
      : "No dedicated private-dining or events page was found on the site.",
    signals.renderedWithJs
      ? "This site renders its content with JavaScript, so a browser-rendering pass was used to read it."
      : null,
    "Always confirm details directly with the venue before booking.",
  ].filter((part): part is string => part !== null);

  return {
    placeSourceId: candidate.placeSourceId,
    name: candidate.name,
    formattedAddress: candidate.formattedAddress,
    lat: candidate.lat,
    lng: candidate.lng,
    category: candidate.category,
    website: candidate.website ?? null,
    phone: signals.phone ?? candidate.phone ?? null,
    email: signals.email,
    priceTier,
    priceTierTrust: priceTier ? "likely" : "unverified",
    minSpendUsd,
    minSpendTrust,
    description: signals.descriptionExcerpt ?? `${candidate.name} — discovered near your search location.`,
    sourceNote: sourceNoteParts.join(" "),
    rooms,
    imageUrl: candidate.photoUrl ?? null,
    menuUrl: signals.menuUrl,
    // A menu link found while a private-dining page was confirmed is a real
    // artifact on the venue's own site; the same link found without one could
    // just be the regular restaurant menu.
    menuTrust: signals.menuUrl ? (signals.privateDiningPageFound ? "verified" : "likely") : "unverified",
    dietaryNotes,
    dietaryTrust,
  };
}
