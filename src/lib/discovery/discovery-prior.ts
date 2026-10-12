/**
 * Discovery prior: P(a candidate venue hosts private events), from metadata we
 * already have before fetching anything — Google Places types and price level
 * [D3], or OSM amenity/cuisine tags [D10], whether a website exists, and name
 * keywords.
 *
 * Used only to order candidates. Discovery order is proximity and place type,
 * not private-dining capability, so in a dense area the per-run candidate cap
 * and the render/LLM budgets were spent on whatever happened to be nearest
 * (pizza counters included). Sorting by this prior first spends them on the
 * likeliest venues. Nothing is persisted, so no Places content is stored
 * beyond what discovery already stored [D3b].
 *
 * Logistic over the features below; placeholder weights in
 * src/data/discovery-prior.json, refittable with
 * `python3 scripts/train_confidence.py --target prior` from
 * hosts_private_events labels (LogisticRegression [D9]).
 */
import prior from "@/data/discovery-prior.json";
import type { CandidateVenue } from "@/lib/discovery/places";

export const PRIOR_KINDS = [
  "banquet",
  "hotel",
  "steakhouse",
  "restaurant",
  "bar",
  "night_club",
  "cafe",
  "fast_food",
] as const;
export const PRIOR_NAME_KEYWORDS = [
  "steakhouse",
  "grill",
  "tavern",
  "hall",
  "club",
  "hotel",
  "pizza",
  "express",
  "cafe",
] as const;

export type DiscoveryPriorModel = { version: string; intercept: number; weights: Record<string, number> };
export const DISCOVERY_PRIOR_MODEL: DiscoveryPriorModel = prior;

const KIND_PATTERNS: Record<(typeof PRIOR_KINDS)[number], RegExp> = {
  banquet: /banquet|event[_\s-]*(venue|hall|space)|events_venue|wedding_venue|convention|conference/,
  hotel: /hotel|resort|lodging|motel/,
  steakhouse: /steak/,
  restaurant: /restaurant|dining/,
  bar: /\bbar\b|(^|[_\s])bar([_\s]|$)|\bpub\b|wine_bar|cocktail|brewery/,
  night_club: /night[_\s-]*club|nightclub/,
  cafe: /cafe|coffee|bakery|tea_house/,
  fast_food: /fast[_\s-]*food|meal_takeaway|sandwich|hamburger|pizza_delivery|food_court/,
};

/** Shared with scripts/train_confidence.py (--target prior); keep the two in step. */
export function encodePriorFeatures(
  c: Pick<CandidateVenue, "name" | "category" | "website" | "priceLevelGoogle" | "types" | "cuisine">
): Record<string, number> {
  const kindText = [c.category, c.cuisine, ...(c.types ?? [])].filter(Boolean).join(" ").toLowerCase();
  const name = c.name.toLowerCase();
  const x: Record<string, number> = {
    priceLevel: c.priceLevelGoogle ?? 0,
    priceLevelMissing: c.priceLevelGoogle == null ? 1 : 0,
    hasWebsite: c.website ? 1 : 0,
  };
  for (const kind of PRIOR_KINDS) if (KIND_PATTERNS[kind].test(kindText)) x[`kind=${kind}`] = 1;
  for (const word of PRIOR_NAME_KEYWORDS) if (new RegExp(`\\b${word}`).test(name)) x[`name=${word}`] = 1;
  return x;
}

export function scorePrivateEventPrior(
  candidate: Pick<CandidateVenue, "name" | "category" | "website" | "priceLevelGoogle" | "types" | "cuisine">,
  model: DiscoveryPriorModel = DISCOVERY_PRIOR_MODEL
): number {
  const x = encodePriorFeatures(candidate);
  const z = Object.entries(x).reduce((sum, [k, v]) => sum + (model.weights[k] ?? 0) * v, model.intercept);
  return 1 / (1 + Math.exp(-z));
}

/**
 * Highest prior first. Stable, so equal priors keep discovery (proximity)
 * order. Candidates without a website stay in the list — they're still
 * drafted, as before — they just sort later.
 */
export function orderByPrior<
  T extends Pick<CandidateVenue, "name" | "category" | "website" | "priceLevelGoogle" | "types" | "cuisine">,
>(candidates: T[]): T[] {
  return candidates
    .map((candidate, index) => ({ candidate, index, prior: scorePrivateEventPrior(candidate) }))
    .sort((a, b) => b.prior - a.prior || a.index - b.index)
    .map(({ candidate }) => candidate);
}
