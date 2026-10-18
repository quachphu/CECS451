/**
 * Discovery prior: P(a candidate venue hosts private events), from metadata we
 * already have before fetching anything. Used only to order candidates:
 * discovery order is proximity and place type, so in a dense area the
 * per-run candidate cap and the render/LLM budgets were spent on whatever
 * happened to be nearest. Sorting by this prior first spends them on the
 * likeliest venues. Nothing is persisted [D3b].
 *
 * Two versions:
 *  - trained (src/data/discovery-prior.json from ml/train_discovery.py): the
 *    "pre_fetch" logistic model over features.ts discoveryFeatures (bucket,
 *    Google price level, rating, review count, name keywords);
 *  - v0 (V0_PRIOR_MODEL below): hand-set weights, used while the file is a
 *    placeholder and kept as the baseline the trained prior is compared to.
 */
import priorJson from "@/data/discovery-prior.json";
import { bucketFromGoogle, bucketFromText, REFERENCE_BUCKET } from "@/lib/discovery/category-buckets";
import { discoveryFeatures } from "@/lib/discovery/features";
import { loadTrainedDiscoveryPrior, scoreLogistic, type DiscoveryPriorModel } from "@/lib/discovery/model-scoring";
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

export type V0PriorModel = { version: string; intercept: number; weights: Record<string, number> };

/** The hand-set v0 prior: ordering before training, and the baseline in eval. */
export const V0_PRIOR_MODEL: V0PriorModel = {
  version: "placeholder-0",
  intercept: -1.2,
  weights: {
    "kind=banquet": 3.0,
    "kind=hotel": 1.4,
    "kind=steakhouse": 1.1,
    "kind=restaurant": 0.5,
    "kind=bar": 0.3,
    "kind=night_club": 0.4,
    "kind=cafe": -0.8,
    "kind=fast_food": -2.0,
    priceLevel: 0.3,
    priceLevelMissing: -0.1,
    hasWebsite: 0.8,
    "name=steakhouse": 0.4,
    "name=grill": 0.2,
    "name=tavern": 0.3,
    "name=hall": 0.5,
    "name=club": 0.2,
    "name=hotel": 0.6,
    "name=pizza": -0.6,
    "name=express": -0.9,
    "name=cafe": -0.5,
  },
};

/** The trained prior, or null while src/data/discovery-prior.json is a placeholder. */
export const TRAINED_DISCOVERY_PRIOR: DiscoveryPriorModel | null = loadTrainedDiscoveryPrior(priorJson);

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

/** v0 features (kind, price, website, name keywords). */
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

/** The v0 hand-set prior. */
export function scorePrivateEventPrior(
  candidate: Pick<CandidateVenue, "name" | "category" | "website" | "priceLevelGoogle" | "types" | "cuisine">,
  model: V0PriorModel = V0_PRIOR_MODEL
): number {
  const x = encodePriorFeatures(candidate);
  const z = Object.entries(x).reduce((sum, [k, v]) => sum + (model.weights[k] ?? 0) * v, model.intercept);
  return 1 / (1 + Math.exp(-z));
}

type PriorCandidate = Pick<
  CandidateVenue,
  "name" | "category" | "website" | "priceLevelGoogle" | "types" | "cuisine" | "primaryType" | "rating" | "userRatingCount"
>;

/** The candidate's bucket as training saw it: Google types first, then the category or cuisine text. */
export function candidateBucket(c: Pick<CandidateVenue, "category" | "types" | "cuisine" | "primaryType">) {
  return bucketFromGoogle(c.primaryType ?? null, c.types ?? []) ?? bucketFromText(c.cuisine) ?? bucketFromText(c.category) ?? REFERENCE_BUCKET;
}

/** P(hosts private events): the trained pre-fetch model when loaded, else the v0 prior. */
export function discoveryPriorScore(candidate: PriorCandidate, trained: DiscoveryPriorModel | null = TRAINED_DISCOVERY_PRIOR): number {
  if (!trained) return scorePrivateEventPrior(candidate);
  return scoreLogistic(
    trained.pre_fetch,
    discoveryFeatures({
      bucket: candidateBucket(candidate),
      name: candidate.name,
      priceLevel: candidate.priceLevelGoogle ?? null,
      rating: candidate.rating ?? null,
      userRatingCount: candidate.userRatingCount ?? null,
    })
  );
}

/**
 * Highest prior first. Stable, so equal priors keep discovery (proximity)
 * order. Candidates without a website stay in the list — they're still
 * drafted, as before — they just sort later.
 */
export function orderByPrior<T extends PriorCandidate>(
  candidates: T[],
  trained: DiscoveryPriorModel | null = TRAINED_DISCOVERY_PRIOR
): T[] {
  return candidates
    .map((candidate, index) => ({ candidate, index, prior: discoveryPriorScore(candidate, trained) }))
    .sort((a, b) => b.prior - a.prior || a.index - b.index)
    .map(({ candidate }) => candidate);
}
