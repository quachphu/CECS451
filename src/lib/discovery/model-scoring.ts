/**
 * Scoring for the models trained offline in ml/ and exported to src/data/:
 * the room-capacity confidence model, the discovery prior and the fit prior.
 *
 * Pure functions, no I/O. scoreLogistic reproduces scikit-learn's pipeline
 * exactly (median imputation, z-scaling of the scaled columns, logistic
 * regression, optional Platt step); model-scoring.test.ts checks it against
 * predict_proba to 1e-6 on the rows in __fixtures__/model-parity.json.
 *
 * A model file that is missing, malformed, or still a placeholder
 * ("version": "placeholder…") loads as null, and callers fall back to the v0
 * behaviour.
 */

export type LogisticModel = {
  version: string;
  feature_order: string[];
  impute_median: Record<string, number>;
  scaler: Record<string, { mean: number; std: number }>;
  coef: number[];
  intercept: number;
  /** Platt step fitted after the logistic output: p = 1 / (1 + exp(a·z + b)). */
  calibration: { a: number; b: number } | null;
};

export type FitPriorModel = {
  version: string;
  headcounts: number[];
  global: { q: number[] };
  buckets: Record<string, { q: number[]; n?: number }>;
};

export class ModelFormatError extends Error {}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function fail(name: string, why: string): never {
  throw new ModelFormatError(`${name}: ${why}`);
}

/** Validates one exported logistic model: feature order present, lengths match, every number finite. */
export function loadModel(json: unknown, name = "model", version = ""): LogisticModel {
  const m = json as Partial<LogisticModel> | null;
  if (!m || typeof m !== "object") fail(name, "not an object");
  const order = m.feature_order;
  if (!Array.isArray(order) || order.length === 0 || !order.every((f) => typeof f === "string"))
    fail(name, "feature_order missing");
  if (new Set(order).size !== order.length) fail(name, "duplicate features in feature_order");
  if (!Array.isArray(m.coef) || m.coef.length !== order.length) fail(name, "coef length does not match feature_order");
  if (!m.coef.every(finite)) fail(name, "non-finite coefficient");
  if (!finite(m.intercept)) fail(name, "non-finite intercept");
  const medians = m.impute_median ?? {};
  for (const f of order) if (!finite(medians[f])) fail(name, `impute_median.${f} missing or non-finite`);
  const scaler = m.scaler ?? {};
  for (const [f, s] of Object.entries(scaler)) {
    if (!order.includes(f)) fail(name, `scaler for unknown feature ${f}`);
    if (!finite(s?.mean) || !finite(s?.std) || s.std === 0) fail(name, `scaler.${f} invalid`);
  }
  const cal = m.calibration ?? null;
  if (cal && (!finite(cal.a) || !finite(cal.b))) fail(name, "calibration a/b not finite");
  return {
    version: version || String((m as { version?: unknown }).version ?? ""),
    feature_order: order,
    impute_median: medians,
    scaler,
    coef: m.coef,
    intercept: m.intercept,
    calibration: cal,
  };
}

export function isTrainedVersion(json: unknown): boolean {
  const v = (json as { version?: unknown } | null)?.version;
  return typeof v === "string" && v.length > 0 && !v.startsWith("placeholder");
}

/** P(y = 1) for one row. Missing (null, undefined, NaN) features take the training median. */
export function scoreLogistic(model: LogisticModel, features: Record<string, number | null | undefined>): number {
  let z = model.intercept;
  model.feature_order.forEach((f, i) => {
    const raw = features[f];
    let x = raw == null || Number.isNaN(raw) ? model.impute_median[f] : raw;
    const s = model.scaler[f];
    if (s) x = (x - s.mean) / s.std;
    z += model.coef[i] * x;
  });
  if (model.calibration) return 1 / (1 + Math.exp(model.calibration.a * z + model.calibration.b));
  return 1 / (1 + Math.exp(-z));
}

/** The trained confidence model from src/data/confidence-model.json, or null while it is a placeholder. */
export function loadTrainedConfidenceModel(json: unknown): LogisticModel | null {
  if (!isTrainedVersion(json)) return null;
  return loadModel(json, "confidence-model.json", (json as { version: string }).version);
}

export type DiscoveryPriorModel = {
  version: string;
  pre_fetch: LogisticModel;
  post_fetch: LogisticModel | null;
};

/** The trained discovery prior (both variants), or null while it is a placeholder. */
export function loadTrainedDiscoveryPrior(json: unknown): DiscoveryPriorModel | null {
  if (!isTrainedVersion(json)) return null;
  const j = json as { version: string; variants?: Record<string, unknown> };
  if (!j.variants?.pre_fetch) fail("discovery-prior.json", "variants.pre_fetch missing");
  return {
    version: j.version,
    pre_fetch: loadModel(j.variants.pre_fetch, "discovery-prior.json pre_fetch", j.version),
    post_fetch: j.variants.post_fetch ? loadModel(j.variants.post_fetch, "discovery-prior.json post_fetch", j.version) : null,
  };
}

/** Validates the fit-prior table: an increasing headcount grid, each row the grid's length, q in [0, 1]. */
export function loadFitPrior(json: unknown, name = "fit-priors.json"): FitPriorModel {
  const m = json as Partial<FitPriorModel> | null;
  const grid = m?.headcounts;
  if (!Array.isArray(grid) || grid.length < 2 || !grid.every(finite)) fail(name, "headcounts missing");
  for (let i = 1; i < grid.length; i++) if (grid[i] <= grid[i - 1]) fail(name, "headcounts not increasing");
  const check = (label: string, q: unknown) => {
    if (!Array.isArray(q) || q.length !== grid.length || !q.every((v) => finite(v) && v >= 0 && v <= 1))
      fail(name, `${label}.q invalid`);
  };
  check("global", m?.global?.q);
  for (const [b, row] of Object.entries(m?.buckets ?? {})) check(`buckets.${b}`, row?.q);
  return {
    version: String((m as { version?: unknown }).version ?? ""),
    headcounts: grid,
    global: m!.global!,
    buckets: m!.buckets ?? {},
  };
}

export function loadTrainedFitPrior(json: unknown): FitPriorModel | null {
  if (!isTrainedVersion(json)) return null;
  return loadFitPrior(json);
}

/**
 * q(bucket, h): P(the venue's largest published room holds h guests), linearly
 * interpolated between grid points and clamped to the grid ends. An unknown
 * bucket uses the global row.
 */
export function fitPrior(model: FitPriorModel, bucket: string, headcount: number): number {
  const q = (model.buckets[bucket] ?? model.global).q;
  const h = model.headcounts;
  if (headcount <= h[0]) return q[0];
  if (headcount >= h[h.length - 1]) return q[q.length - 1];
  let i = 1;
  while (h[i] < headcount) i++;
  const t = (headcount - h[i - 1]) / (h[i] - h[i - 1]);
  return q[i - 1] + t * (q[i] - q[i - 1]);
}
