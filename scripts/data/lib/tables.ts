/**
 * Train/test tables (Step 8): splits by website domain, label rows, and the
 * confidence and discovery feature rows.
 */
import {
  bucketFromGoogle,
  BUCKETS,
  type Bucket,
} from "../../../src/lib/discovery/category-buckets";
import {
  CONFIDENCE_FEATURE_ORDER,
  DISCOVERY_POST_FETCH_ORDER,
  discoveryFeatures,
  encodeConfidenceFeatures,
  type ConfidenceFeatures,
} from "../../../src/lib/discovery/features";
import { canonicalRoomName } from "../../../src/lib/discovery/room-normalize";
import { scorePrivateEventPrior } from "../../../src/lib/discovery/discovery-prior";
import {
  V0_DISCOVERY_PRIOR_MODEL,
  V0_TRUST_WEIGHT,
} from "../../../eval/baselines";
import { correctness, matchRoom, type LabelRoom, type Style } from "./matching";

export type Split = "train" | "test_gold" | "test_la_teacher";

export type VenueLabel = {
  venueId: string;
  source: "gold" | "teacher";
  status: "labeled" | "unclear";
  hosts: "yes" | "no" | "unknown";
  rooms: LabelRoom[];
  totalSeats: number | null;
};

export const CONFIDENCE_COLUMNS = [
  "venue_id",
  "domain",
  "city",
  "bucket",
  "room_key",
  "split",
  "label_source",
  "y",
  "abs_rel_error",
  ...CONFIDENCE_FEATURE_ORDER,
  "b0_v0_trust",
] as const;

export const DISCOVERY_COLUMNS = [
  "venue_id",
  "domain",
  "city",
  "bucket",
  "split",
  "label_source",
  "y",
  ...DISCOVERY_POST_FETCH_ORDER,
  "v0_prior",
] as const;

/**
 * Test = every gold venue plus every LA venue; train = everything else. A
 * domain is never on both sides: any domain holding a test venue is test.
 */
export function assignSplits(
  venues: Array<{ venueId: string; domain: string; city: string }>,
  goldIds: Set<string>,
): Map<string, Split> {
  const testDomains = new Set(
    venues
      .filter((v) => goldIds.has(v.venueId) || v.city === "LA")
      .map((v) => v.domain),
  );
  return new Map(
    venues.map((v) => [
      v.venueId,
      goldIds.has(v.venueId)
        ? "test_gold"
        : v.city === "LA" || testDomains.has(v.domain)
          ? "test_la_teacher"
          : "train",
    ]),
  );
}

export class LeakageError extends Error {}

/** Throws if a gold or LA venue, or a test domain, appears in training rows. */
export function assertNoLeakage(
  trainRows: Array<{ venue_id: string; domain: string; city: string }>,
  testRows: Array<{ domain: string }>,
  goldIds: Set<string>,
): void {
  const testDomains = new Set(testRows.map((r) => r.domain));
  for (const r of trainRows) {
    if (goldIds.has(r.venue_id))
      throw new LeakageError(`gold venue ${r.venue_id} is in a training file`);
    if (r.city === "LA")
      throw new LeakageError(`LA venue ${r.venue_id} is in a training file`);
    if (testDomains.has(r.domain))
      throw new LeakageError(`domain ${r.domain} is in both train and test`);
  }
}

/**
 * Baseline B0: the v0 trust weight for a room, by the v0 rules (eval/baselines.ts
 * v0Rooms): a figure read from the page is `verified` when a private-dining page
 * was found, else `unverified`; with no figure on the page, `likely` with a
 * private-dining page, else `unverified`.
 */
export function v0TrustWeight(f: ConfidenceFeatures): number {
  const figureOnPage = f.regex_status !== "absent";
  if (f.private_page_found)
    return V0_TRUST_WEIGHT[figureOnPage ? "verified" : "likely"];
  return V0_TRUST_WEIGHT.unverified;
}

export type ExtractionLike = {
  venue_id: string;
  room_key: string;
  room_name: string;
  capacity: number;
  style: Style;
  features: ConfidenceFeatures | null;
  extraction_failed: boolean;
};

/** One labelled confidence row per extracted room; null (with a reason) when the row is excluded. */
export function confidenceRow(
  ex: ExtractionLike,
  label: VenueLabel | undefined,
): { row: Record<string, string | number> } | { excluded: string } {
  if (ex.extraction_failed || !ex.features)
    return { excluded: "extraction_failed" };
  if (!label) return { excluded: "no_label" };
  if (label.status === "unclear") return { excluded: "label_unclear" };
  const match = matchRoom(
    {
      roomKey: ex.room_key,
      roomName: canonicalRoomName(ex.room_name),
      style: ex.style,
      capacity: ex.capacity,
    },
    label.rooms,
    label.totalSeats,
  );
  const { y, absRelError } = correctness(ex.capacity, match);
  return {
    row: {
      room_key: ex.room_key,
      label_source: label.source,
      y,
      abs_rel_error: absRelError == null ? "" : Number(absRelError.toFixed(6)),
      ...encodeConfidenceFeatures(ex.features),
      b0_v0_trust: v0TrustWeight(ex.features),
    },
  };
}

export type GoogleRow = Record<string, string>;

/** The hand-set discovery prior that shipped before training (the v0 order baseline). */
export function v0Prior(
  venue: { name: string; bucket: Bucket; website: string },
  google: GoogleRow | undefined,
): number {
  const matched = google?.google_match === "matched";
  return scorePrivateEventPrior(
    {
      name: matched && google!.display_name ? google!.display_name : venue.name,
      category: (matched && google!.primary_type) || venue.bucket,
      website: venue.website || undefined,
      priceLevelGoogle:
        matched && google!.price_level !== "" && google!.price_level != null
          ? Number(google!.price_level)
          : undefined,
      types: matched ? (google!.types || "").split("|").filter(Boolean) : [],
      cuisine: undefined,
    },
    V0_DISCOVERY_PRIOR_MODEL,
  );
}

/** Discovery features exactly as the app computes them, from Google's fields when matched. */
export function discoveryRow(
  venue: { name: string; bucket: Bucket },
  google: GoogleRow | undefined,
  hasExternalEventLink: boolean,
): Record<string, number | null> {
  const matched = google?.google_match === "matched";
  const num = (s: string | undefined) =>
    s == null || s === "" ? null : Number(s);
  const bucket =
    (matched
      ? bucketFromGoogle(
          google!.primary_type || null,
          (google!.types || "").split("|").filter(Boolean),
        )
      : null) ?? venue.bucket;
  return discoveryFeatures({
    bucket: BUCKETS.includes(bucket) ? bucket : venue.bucket,
    name: matched && google!.display_name ? google!.display_name : venue.name,
    priceLevel: matched ? num(google!.price_level) : null,
    rating: matched ? num(google!.rating) : null,
    userRatingCount: matched ? num(google!.user_rating_count) : null,
    hasExternalEventLink,
  });
}
