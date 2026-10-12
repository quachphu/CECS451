/**
 * Evaluation metrics for the Phase 2/3 reports. Pure functions; unit-tested
 * against scikit-learn on hand cases (src/lib/eval-metrics.test.ts).
 */

/**
 * DCG@k with exponential gains, per Järvelin & Kekäläinen [P8]:
 *   DCG = Σ_{i=1..k} (2^rel_i − 1) / log2(i + 1)
 */
export function dcgAtK(relevances: number[], k: number): number {
  return relevances.slice(0, k).reduce((sum, rel, i) => sum + (2 ** rel - 1) / Math.log2(i + 2), 0);
}

/**
 * NDCG@k: DCG of the ranking divided by DCG of the ideal ordering of every
 * judged item (`allJudged`). 0 when nothing judged is relevant.
 *
 * scikit-learn's ndcg_score [D11] uses linear gains; it matches this when
 * given (2^rel − 1) as y_true, which is how the tests cross-check it.
 */
export function ndcgAtK(rankedRelevances: number[], allJudged: number[], k = 5): number {
  const ideal = dcgAtK(
    [...allJudged].sort((a, b) => b - a),
    k
  );
  return ideal === 0 ? 0 : dcgAtK(rankedRelevances, k) / ideal;
}

/**
 * Cohen's kappa [P9]: κ = (p_o − p_e) / (1 − p_e), where p_o is observed
 * agreement and p_e the agreement expected by chance from each rater's
 * marginals. Matches sklearn cohen_kappa_score [D12] (κ = 0 when p_e = 1).
 */
export function cohenKappa<T extends string | number>(
  a: T[],
  b: T[]
): { po: number; pe: number; kappa: number; n: number } {
  if (a.length !== b.length) throw new Error("raters must label the same items");
  const n = a.length;
  if (n === 0) return { po: 0, pe: 0, kappa: 0, n };
  const labels = Array.from(new Set([...a, ...b]));
  const po = a.filter((x, i) => x === b[i]).length / n;
  const pe = labels.reduce(
    (sum, l) => sum + (a.filter((x) => x === l).length / n) * (b.filter((x) => x === l).length / n),
    0
  );
  return { po, pe, kappa: pe === 1 ? 0 : (po - pe) / (1 - pe), n };
}

/**
 * Expected Calibration Error per Naeini et al. 2015 [P5] (Guo et al. 2017
 * [P4]): ECE = Σ_b (n_b / N)·|acc(b) − conf(b)| over equal-width bins. Bins
 * are left-open as in gpleiss/temperature_scaling [C2], except the first,
 * which also includes 0 — identical to scripts/train_confidence.py.
 */
export function expectedCalibrationError(confidences: number[], correct: Array<boolean | 0 | 1>, nBins = 10): number {
  const n = confidences.length;
  if (n === 0) return 0;
  let ece = 0;
  for (let b = 0; b < nBins; b++) {
    const lo = b / nBins;
    const hi = (b + 1) / nBins;
    const idx = confidences.flatMap((c, i) => ((b === 0 ? c >= lo : c > lo) && c <= hi ? [i] : []));
    if (idx.length === 0) continue;
    const acc = idx.filter((i) => Boolean(correct[i])).length / idx.length;
    const conf = idx.reduce((s, i) => s + confidences[i], 0) / idx.length;
    ece += (idx.length / n) * Math.abs(acc - conf);
  }
  return ece;
}

/** Precision, recall and F1 of boolean predictions against labels [P1]. */
export function precisionRecallF1(
  predicted: boolean[],
  actual: boolean[]
): { precision: number; recall: number; f1: number } {
  const tp = predicted.filter((p, i) => p && actual[i]).length;
  const fp = predicted.filter((p, i) => p && !actual[i]).length;
  const fn = predicted.filter((p, i) => !p && actual[i]).length;
  const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
  return { precision, recall, f1: precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall) };
}

/** True when `predicted` is within ±tolerance (relative) of `actual`. */
export function withinTolerance(predicted: number, actual: number, tolerance = 0.1): boolean {
  return actual > 0 && Math.abs(predicted - actual) / actual <= tolerance;
}
