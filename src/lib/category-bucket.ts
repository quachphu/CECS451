/**
 * Collapses free-form venue categories (Google types, OSM amenity tags, the
 * curated seed's "Italian, family-style") into a handful of buckets that the
 * confidence model, the fit priors and the discovery prior can share.
 */
export const CATEGORY_BUCKETS = ["banquet", "hotel", "bar", "club", "restaurant", "other"] as const;
export type CategoryBucket = (typeof CATEGORY_BUCKETS)[number];

export function categoryBucket(category: string | null | undefined): CategoryBucket {
  const c = (category ?? "").toLowerCase();
  if (/banquet|ballroom|event[\s_-]*(space|venue|hall)|events_venue|conference/.test(c)) return "banquet";
  if (/hotel|resort|lodging/.test(c)) return "hotel";
  if (/night|club/.test(c)) return "club";
  if (/\bbar\b|pub|lounge|tavern|brewery|wine/.test(c)) return "bar";
  if (/restaurant|dining|grill|steak|italian|mexican|greek|american|seafood|bistro|cafe|cuisine|kitchen|food/.test(c)) {
    return "restaurant";
  }
  return "other";
}
