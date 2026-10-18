/**
 * Venue category buckets shared by the training data and the app.
 *
 * Venues are sampled from Foursquare (category paths such as
 * "Dining and Drinking > Bar > Cocktail Bar"), while the app sees Google
 * Places types ("cocktail_bar") or its own category text ("Hotel event
 * space"). All three are mapped here, to the same seven buckets, so a model
 * trained on one source scores the other the same way.
 */

export const BUCKETS = [
  "fine_dining",
  "casual_restaurant",
  "steakhouse_grill",
  "bar_lounge",
  "hotel",
  "event_space",
  "fast_casual_cafe",
] as const;
export type Bucket = (typeof BUCKETS)[number];

/** One-hot reference category for the logistic models (its indicator is omitted). */
export const REFERENCE_BUCKET: Bucket = "casual_restaurant";

/**
 * Text rules, checked in this order; the first match wins. More specific
 * buckets come first: "Bar and Grill" is a grill, and "Hotel Bar" a bar.
 */
const TEXT_RULES: Array<[Bucket, RegExp]> = [
  [
    "event_space",
    /event[\s_-]*(space|venue|hall)|banquet|ballroom|wedding|conference|convention|reception[\s_-]*(hall|venue)|party[\s_-]*venue/,
  ],
  ["hotel", /\b(hotels?|resorts?|motel|inn|lodging|bed and breakfast)\b(?![\s_-]*(bar|lounge|restaurant))/],
  ["fine_dining", /fine[\s_-]*dining|tasting[\s_-]*menu|molecular gastronomy/],
  ["steakhouse_grill", /steak[\s_-]*house|steakhouse|chop[\s_-]*house|churrascaria|\bgrill\b|bbq|barbecue/],
  [
    "bar_lounge",
    /\bbars?\b|lounge|\bpubs?\b|gastropub|brew[\s_-]*pub|brewery|night[\s_-]*club|nightclub|nightlife|speakeasy|beer garden|tavern|karaoke/,
  ],
  [
    "fast_casual_cafe",
    /caf[eé]|coffee|bakery|fast[\s_-]*food|sandwich|food[\s_-]*(truck|court|stand)|\bdeli\b|bagel|donut|doughnut|ice cream|dessert|juice|smoothie|tea[\s_-]*(room|house)|bubble tea|snack|creperie|pizz|burger|fried chicken|taco|hot dog|takeaway|take[\s_-]*out/,
  ],
  ["casual_restaurant", /restaurant|diner|bistro|brasserie|eatery|trattoria|osteria|taverna|kitchen|dining/],
];

/** Bucket for free text: a Foursquare category path, or the app's own category label. */
export function bucketFromText(text: string | null | undefined): Bucket | null {
  const t = (text ?? "").toLowerCase().replace(/_/g, " ");
  if (!t.trim()) return null;
  for (const [bucket, rule] of TEXT_RULES) if (rule.test(t)) return bucket;
  return null;
}

const PRIORITY = TEXT_RULES.map(([bucket]) => bucket);

/** A venue with several Foursquare categories takes the highest-priority bucket among them. */
export function bucketFromFsqLabels(labels: Array<string | null | undefined>): Bucket | null {
  let best: Bucket | null = null;
  for (const label of labels) {
    const bucket = bucketFromText(label);
    if (bucket && (best == null || PRIORITY.indexOf(bucket) < PRIORITY.indexOf(best))) best = bucket;
  }
  return best;
}

/** Google Places (New) types → bucket. Types not listed fall through to the text rules. */
export const GOOGLE_TYPE_BUCKETS: Record<string, Bucket> = {
  banquet_hall: "event_space",
  event_venue: "event_space",
  wedding_venue: "event_space",
  convention_center: "event_space",
  hotel: "hotel",
  resort_hotel: "hotel",
  lodging: "hotel",
  motel: "hotel",
  inn: "hotel",
  extended_stay_hotel: "hotel",
  bed_and_breakfast: "hotel",
  fine_dining_restaurant: "fine_dining",
  steak_house: "steakhouse_grill",
  barbecue_restaurant: "steakhouse_grill",
  bar_and_grill: "steakhouse_grill",
  bar: "bar_lounge",
  pub: "bar_lounge",
  irish_pub: "bar_lounge",
  gastropub: "bar_lounge",
  brewpub: "bar_lounge",
  brewery: "bar_lounge",
  night_club: "bar_lounge",
  wine_bar: "bar_lounge",
  cocktail_bar: "bar_lounge",
  lounge_bar: "bar_lounge",
  sports_bar: "bar_lounge",
  hookah_bar: "bar_lounge",
  karaoke: "bar_lounge",
  cafe: "fast_casual_cafe",
  coffee_shop: "fast_casual_cafe",
  bakery: "fast_casual_cafe",
  fast_food_restaurant: "fast_casual_cafe",
  sandwich_shop: "fast_casual_cafe",
  pizza_restaurant: "fast_casual_cafe",
  hamburger_restaurant: "fast_casual_cafe",
  meal_takeaway: "fast_casual_cafe",
  ice_cream_shop: "fast_casual_cafe",
  dessert_shop: "fast_casual_cafe",
  dessert_restaurant: "fast_casual_cafe",
  donut_shop: "fast_casual_cafe",
  bagel_shop: "fast_casual_cafe",
  juice_shop: "fast_casual_cafe",
  tea_house: "fast_casual_cafe",
  food_court: "fast_casual_cafe",
  cafeteria: "fast_casual_cafe",
  deli: "fast_casual_cafe",
  snack_bar: "fast_casual_cafe",
  diner: "casual_restaurant",
  bistro: "casual_restaurant",
  brunch_restaurant: "casual_restaurant",
  restaurant: "casual_restaurant",
};

/**
 * Bucket from Google's primary type, then its other types, in order. Any other
 * `*_restaurant` type (cuisines) is a casual restaurant; the generic
 * `restaurant`, `food` and `establishment` types are consulted last.
 */
export function bucketFromGoogle(primaryType: string | null | undefined, types: string[] = []): Bucket | null {
  const ordered = [primaryType, ...types].filter((t): t is string => Boolean(t));
  const generic = new Set(["restaurant", "food", "point_of_interest", "establishment"]);
  for (const type of ordered) {
    if (generic.has(type)) continue;
    if (GOOGLE_TYPE_BUCKETS[type]) return GOOGLE_TYPE_BUCKETS[type];
  }
  for (const type of ordered) if (!generic.has(type) && type.endsWith("_restaurant")) return "casual_restaurant";
  return ordered.includes("restaurant") ? "casual_restaurant" : null;
}

/** The app's bucket for a stored venue: Google types when it has them, else its category text. */
export function bucketForVenue(venue: { category?: string | null; types?: string[] | null }): Bucket {
  return bucketFromGoogle(null, venue.types ?? []) ?? bucketFromText(venue.category) ?? REFERENCE_BUCKET;
}
