import type { CandidateVenue } from "@/lib/discovery/places";
import { scoreConfidence, type ConfidenceFeatures } from "@/lib/discovery/confidence";
import { findEvidenceUrl } from "@/lib/discovery/grounding";
import type { LlmExtractedRoom, LlmExtraction } from "@/lib/discovery/llm-extract";
import { MIN_PLAUSIBLE_CAPACITY, type CapacityCandidate, type ScrapedSignals } from "@/lib/discovery/scraper";
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
  /** P(capacity is right), scored at write time — see confidence.ts. */
  confidence: number;
  /** What `confidence` was computed from; persisted for offline refitting. */
  confidenceFeatures: ConfidenceFeatures;
};

type RoomEvidence = Pick<
  ConfidenceFeatures,
  "source" | "agreementSpread" | "grounded" | "competingCandidates" | "hasRoomHint"
>;
type PageContext = Pick<ConfidenceFeatures, "privateDiningPageFound" | "renderedWithJs" | "category">;

function scored(
  room: Omit<DraftRoom, "confidence" | "confidenceFeatures">,
  evidence: RoomEvidence,
  page: PageContext
): DraftRoom {
  const confidenceFeatures: ConfidenceFeatures = { ...evidence, ...page };
  return { ...room, confidence: scoreConfidence(confidenceFeatures), confidenceFeatures };
}

const ESTIMATE_EVIDENCE: RoomEvidence = {
  source: "estimate",
  agreementSpread: null,
  grounded: false,
  competingCandidates: 0,
  hasRoomHint: false,
};

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

/** Candidates from hand-built signals (tests, eval baselines) that only carry capacityNumbers. */
function candidatesOf(signals: ScrapedSignals): CapacityCandidate[] {
  const raw =
    signals.capacityCandidates ??
    signals.capacityNumbers.map((value) => ({ value, context: "", sentence: "", roomHint: null }));
  return raw.filter((c) => c.value >= MIN_PLAUSIBLE_CAPACITY);
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
function roomsFromEvidence(
  signals: ScrapedSignals,
  llmRooms: LlmExtractedRoom[],
  style: RoomStyle,
  page: PageContext
): DraftRoom[] | null {
  const candidates = candidatesOf(signals);
  const pages = signals.pages ?? [];

  if (llmRooms.length > 0) {
    return llmRooms.map((room): DraftRoom => {
      const evidenceUrl = findEvidenceUrl(room.evidenceQuote, pages);
      const agreeing = candidates
        .filter((c) => capacitySpread(c.value, room.maxCapacity) <= AGREEMENT_TOLERANCE)
        .sort(
          (a, b) =>
            Number(sameRoom(b.roomHint, room.roomName)) - Number(sameRoom(a.roomHint, room.roomName)) ||
            capacitySpread(a.value, room.maxCapacity) - capacitySpread(b.value, room.maxCapacity)
        )[0];

      if (agreeing) {
        return scored(
          {
            roomName: room.roomName,
            minCapacity: room.minCapacity != null && room.minCapacity <= agreeing.value ? room.minCapacity : undefined,
            maxCapacity: agreeing.value,
            style,
            capacityTrust: "verified",
            notes: agreementNote(agreeing.value, room.maxCapacity),
            isEstimate: false,
            evidenceQuote: room.evidenceQuote ?? (agreeing.sentence || null),
            evidenceUrl: evidenceUrl ?? agreeing.url ?? null,
          },
          {
            source: "both",
            agreementSpread: capacitySpread(agreeing.value, room.maxCapacity),
            grounded: true,
            competingCandidates: Math.max(0, candidates.length - 1),
            hasRoomHint: true,
          },
          page
        );
      }

      // The same room read two ways: matched by name, or — when the page has a
      // single room — the regex's own pick for that room.
      const conflicting =
        candidates.find((c) => sameRoom(c.roomHint, room.roomName)) ??
        (llmRooms.length === 1 && candidates.length > 0 ? pickRegexCandidates(candidates)[0] : undefined);

      if (conflicting) {
        return scored(
          {
            roomName: room.roomName,
            maxCapacity: conflicting.value,
            style,
            capacityTrust: "likely",
            notes: disagreementNote(conflicting.value, room.maxCapacity),
            isEstimate: false,
            evidenceQuote: conflicting.sentence || null,
            evidenceUrl: conflicting.url ?? null,
          },
          {
            source: "both",
            agreementSpread: capacitySpread(conflicting.value, room.maxCapacity),
            grounded: true,
            competingCandidates: Math.max(0, candidates.length - 1),
            hasRoomHint: Boolean(conflicting.roomHint),
          },
          page
        );
      }

      return scored(
        {
          roomName: room.roomName,
          minCapacity: room.minCapacity ?? undefined,
          maxCapacity: room.maxCapacity,
          style,
          capacityTrust: "ai_extracted",
          notes:
            "Read from the venue's own page by AI because the page states capacity in prose rather than a standard format. Confirm before booking.",
          isEstimate: false,
          evidenceQuote: room.evidenceQuote ?? null,
          evidenceUrl,
        },
        {
          source: "llm",
          agreementSpread: null,
          grounded: Boolean(room.evidenceQuote),
          competingCandidates: candidates.length,
          hasRoomHint: true,
        },
        page
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
            capacityTrust: signals.privateDiningPageFound ? "likely" : "unverified",
            notes: signals.privateDiningPageFound
              ? "Capacity figure read from the venue's own private-dining/events page by pattern match, not confirmed by a second independent read — confirm before booking."
              : "Capacity figure appears on the venue's site but not on a private-dining page, so it may not describe a private room — call to confirm.",
            isEstimate: false,
            evidenceQuote: c.sentence || null,
            evidenceUrl: c.url ?? null,
          },
          {
            source: "regex",
            agreementSpread: null,
            grounded: true,
            competingCandidates: candidates.length - picked.length,
            hasRoomHint: Boolean(c.roomHint),
          },
          page
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

  if (!signals || signals.robotsBlocked) {
    const robotsBlocked = Boolean(signals?.robotsBlocked);
    return {
      placeSourceId: candidate.placeSourceId,
      name: candidate.name,
      formattedAddress: candidate.formattedAddress,
      lat: candidate.lat,
      lng: candidate.lng,
      category: candidate.category,
      // Kept when robots.txt is what stopped us — the planner can still visit it.
      website: robotsBlocked ? (candidate.website ?? null) : null,
      phone: candidate.phone ?? null,
      email: null,
      priceTier,
      priceTierTrust: priceTier ? "likely" : "unverified",
      minSpendUsd: null,
      minSpendTrust: "unverified",
      description: `${candidate.name} — discovered near your search location.`,
      sourceNote: robotsBlocked
        ? ROBOTS_BLOCKED_NOTE
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
          ESTIMATE_EVIDENCE,
          { privateDiningPageFound: false, renderedWithJs: false, category: candidate.category }
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

  const page: PageContext = {
    privateDiningPageFound: signals.privateDiningPageFound,
    renderedWithJs: signals.renderedWithJs,
    category: candidate.category,
  };

  const rooms: DraftRoom[] = roomsFromEvidence(signals, llm?.rooms ?? [], style, page) ?? [
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
      ESTIMATE_EVIDENCE,
      page
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
