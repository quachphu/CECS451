/**
 * Inter-labeler agreement on hosts_private_events (Step 9e): Cohen's kappa
 * [P9] between two labelers over the venues both labelled.
 *
 * Run with: npx tsx scripts/eval-agreement.ts [eval/labels.csv] [labelerA labelerB]
 * (defaults to the first two labelers found in the file).
 */
import { readFileSync } from "node:fs";
import { parseLabels } from "../eval/csv";
import { cohenKappa } from "../eval/metrics";

const path = process.argv[2] ?? "eval/labels.csv";
const labels = parseLabels(readFileSync(path, "utf8"));
const labelers = Array.from(new Set(labels.map((l) => l.labeler).filter(Boolean)));
const [a, b] = process.argv.length >= 5 ? [process.argv[3], process.argv[4]] : labelers;
if (!a || !b) {
  console.error(`Need two labelers; found: ${labelers.join(", ") || "none"}`);
  process.exit(1);
}

const byLabeler = (who: string) => {
  const m = new Map<string, number>();
  for (const l of labels.filter((x) => x.labeler === who))
    m.set(l.venue_key, Math.max(m.get(l.venue_key) ?? 0, Number(l.hosts_private_events)));
  return m;
};
const ra = byLabeler(a);
const rb = byLabeler(b);
const shared = [...ra.keys()].filter((k) => rb.has(k)).sort();
const { po, pe, kappa, n } = cohenKappa(
  shared.map((k) => ra.get(k)!),
  shared.map((k) => rb.get(k)!)
);

console.log(`labelers: ${a} vs ${b}`);
console.log(`venues labelled by both: ${n}`);
console.log(`observed agreement p_o = ${po.toFixed(3)}, chance agreement p_e = ${pe.toFixed(3)}`);
console.log(`Cohen's kappa = ${kappa.toFixed(3)}`);
