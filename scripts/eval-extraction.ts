/**
 * Offline extraction evaluation (Step 9c). Compares four systems on the
 * snapshots in eval/snapshots against eval/labels.csv:
 *
 *   v0        the original largest-regex-number logic (eval/baselines.ts)
 *   regex     regex candidates only (buildVenueDraft without an LLM read)
 *   llm       LLM only (grounded extraction; regex candidates withheld)
 *   combined  regex candidates + grounded LLM read (the shipped system)
 *
 * Fully offline: the page text comes from snapshots, and the model's raw
 * answers are cached beside them (eval/snapshots/<key>.llm.json). Missing
 * answers are fetched only when XAI_API_KEY is set — otherwise the two LLM
 * systems report the venues they had to skip.
 *
 * Reports capacity accuracy (exact and within ±10%) per labelled room,
 * private-event precision/recall/F1 per venue [P1], the grounding rejection
 * rate (share of model-proposed rooms whose evidence quote failed the check —
 * our hallucination proxy [P2, P3]), per-trust-tier counts and accuracy, and
 * ECE [P5]. Writes eval/results.json and, for the combined system,
 * eval/features.jsonl for scripts/train_confidence.py.
 *
 * Run with: npx tsx scripts/eval-extraction.ts
 */
import { config } from "dotenv";
config({ path: [".env.local", ".env"] });

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseLabels, type LabelRow } from "../eval/csv";
import { v0Rooms, V0_TRUST_WEIGHT } from "../eval/baselines";
import { expectedCalibrationError, precisionRecallF1, withinTolerance } from "../eval/metrics";
import type { Snapshot } from "./eval-snapshot";
import {
  buildLlmInput,
  groundExtraction,
  requestLlmExtraction,
  type LlmExtraction,
  type RawLlmExtraction,
} from "@/lib/discovery/llm-extract";
import { signalsFromPages, type ScrapedSignals } from "@/lib/discovery/scraper";
import { buildVenueDraft } from "@/lib/discovery/trust";
import type { ConfidenceFeatures } from "@/lib/discovery/confidence";
import type { TrustLevel } from "@/lib/supabase/types";

const EVAL_DIR = join(process.cwd(), "eval");
const SNAPSHOT_DIR = join(EVAL_DIR, "snapshots");

type PredictedRoom = {
  roomName: string;
  maxCapacity: number;
  trust: TrustLevel;
  confidence: number;
  isEstimate: boolean;
  features?: ConfidenceFeatures;
};
type Prediction =
  | { hostsPrivateEvents: boolean; rooms: PredictedRoom[]; rejected: number; proposed: number }
  | "skipped";
type SystemName = "v0" | "regex" | "llm" | "combined";

function normalizeRoom(name: string): string {
  return name
    .toLowerCase()
    .replace(/[’'".,()]/g, "")
    .replace(/\b(the|our|private)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
const sameRoom = (a: string, b: string) => {
  const x = normalizeRoom(a);
  const y = normalizeRoom(b);
  return x.length > 0 && y.length > 0 && (x === y || x.includes(y) || y.includes(x));
};

async function llmFor(
  snapshot: Snapshot,
  signals: ScrapedSignals
): Promise<{ grounded: LlmExtraction; raw: RawLlmExtraction } | null> {
  const cachePath = join(SNAPSHOT_DIR, `${snapshot.venueKey}.llm.json`);
  const input = buildLlmInput(signals.privateDiningText ?? "", signals.combinedText);
  let raw: RawLlmExtraction | null = null;
  if (existsSync(cachePath)) raw = JSON.parse(readFileSync(cachePath, "utf8")) as RawLlmExtraction;
  else if (process.env.XAI_API_KEY && input.trim()) {
    raw = await requestLlmExtraction(snapshot.venueKey, input);
    if (raw) writeFileSync(cachePath, JSON.stringify(raw, null, 1));
  }
  return raw ? { grounded: groundExtraction(raw, input), raw } : null;
}

function fromDraft(draft: ReturnType<typeof buildVenueDraft>): PredictedRoom[] {
  return draft.rooms.map((r) => ({
    roomName: r.roomName,
    maxCapacity: r.maxCapacity,
    trust: r.capacityTrust,
    confidence: r.confidence,
    isEstimate: r.isEstimate,
    features: r.confidenceFeatures,
  }));
}

/** Pairs each labelled room with a predicted room: by name, else (single labelled room) the first prediction. */
function matchRoom(label: LabelRow, labelledRooms: LabelRow[], rooms: PredictedRoom[]): PredictedRoom | null {
  return (
    rooms.find((r) => sameRoom(r.roomName, label.room_name)) ?? (labelledRooms.length === 1 ? (rooms[0] ?? null) : null)
  );
}

async function main() {
  const labels = parseLabels(readFileSync(join(EVAL_DIR, "labels.csv"), "utf8"));
  // One labeler's rows per venue (the first seen) — agreement is measured separately (eval-agreement.ts).
  const firstLabeler = new Map<string, string>();
  for (const l of labels) if (!firstLabeler.has(l.venue_key)) firstLabeler.set(l.venue_key, l.labeler);
  const labelsByVenue = new Map<string, LabelRow[]>();
  for (const l of labels.filter((x) => x.labeler === firstLabeler.get(x.venue_key))) {
    labelsByVenue.set(l.venue_key, [...(labelsByVenue.get(l.venue_key) ?? []), l]);
  }

  const files = existsSync(SNAPSHOT_DIR)
    ? readdirSync(SNAPSHOT_DIR).filter((f) => f.endsWith(".json") && !f.endsWith(".llm.json"))
    : [];
  const predictions: Record<SystemName, Map<string, Prediction>> = {
    v0: new Map(),
    regex: new Map(),
    llm: new Map(),
    combined: new Map(),
  };
  const featureRows: string[] = [];

  for (const file of files) {
    const snapshot = JSON.parse(readFileSync(join(SNAPSHOT_DIR, file), "utf8")) as Snapshot;
    const venueLabels = labelsByVenue.get(snapshot.venueKey);
    if (!venueLabels) continue;
    const category = venueLabels[0].category || "restaurant";
    const candidate = {
      placeSourceId: snapshot.venueKey,
      name: snapshot.venueKey,
      formattedAddress: "",
      lat: 0,
      lng: 0,
      category,
      website: snapshot.url,
    };
    const signals: ScrapedSignals = snapshot.robotsBlocked
      ? { ...signalsFromPages([], [], snapshot.url), robotsBlocked: true }
      : signalsFromPages(snapshot.pages, snapshot.links, snapshot.url, {
          renderedWithJs: Boolean(snapshot.renderedText),
          renderTarget: null,
        });

    const v0 = v0Rooms(signals.combinedText, signals.privateDiningPageFound, category);
    predictions.v0.set(snapshot.venueKey, {
      hostsPrivateEvents: signals.privateDiningPageFound,
      rooms: v0.map((r) => ({
        roomName: r.roomName,
        maxCapacity: r.maxCapacity,
        trust: r.capacityTrust,
        confidence: V0_TRUST_WEIGHT[r.capacityTrust],
        isEstimate: r.isEstimate,
      })),
      rejected: 0,
      proposed: 0,
    });
    predictions.regex.set(snapshot.venueKey, {
      hostsPrivateEvents: signals.privateDiningPageFound,
      rooms: fromDraft(buildVenueDraft(candidate, signals, null)),
      rejected: 0,
      proposed: 0,
    });

    const llm = signals.combinedText ? await llmFor(snapshot, signals) : null;
    if (!llm) {
      predictions.llm.set(snapshot.venueKey, "skipped");
      predictions.combined.set(snapshot.venueKey, "skipped");
      continue;
    }
    const proposed = (llm.raw.rooms ?? []).length;
    const rejected = llm.grounded.rejectedCount ?? 0;
    const withoutRegex: ScrapedSignals = { ...signals, capacityCandidates: [], capacityNumbers: [] };
    predictions.llm.set(snapshot.venueKey, {
      hostsPrivateEvents: llm.grounded.hostsPrivateEvents,
      rooms: fromDraft(buildVenueDraft(candidate, withoutRegex, llm.grounded)),
      rejected,
      proposed,
    });
    const combinedRooms = fromDraft(buildVenueDraft(candidate, signals, llm.grounded));
    predictions.combined.set(snapshot.venueKey, {
      // The LLM can veto a false keyword hit ("weddings" in a blog post).
      hostsPrivateEvents: signals.privateDiningPageFound && llm.grounded.hostsPrivateEvents,
      rooms: combinedRooms,
      rejected,
      proposed,
    });
    for (const room of combinedRooms) {
      featureRows.push(
        JSON.stringify({
          venue_key: snapshot.venueKey,
          system: "combined",
          room_name: room.roomName,
          max_capacity: room.maxCapacity,
          features: room.features,
        })
      );
    }
  }

  const results: Record<string, unknown> = {
    generatedAt: new Date().toISOString(),
    snapshots: files.length,
    labelledVenues: labelsByVenue.size,
  };
  for (const system of Object.keys(predictions) as SystemName[]) {
    const evaluated = [...predictions[system].entries()].filter(
      (e): e is [string, Exclude<Prediction, "skipped">] => e[1] !== "skipped"
    );
    const skipped = predictions[system].size - evaluated.length;

    const roomOutcomes: { exact: boolean; within10: boolean }[] = [];
    const tier: Record<string, { n: number; correct: number }> = {};
    const confidences: number[] = [];
    const correctness: boolean[] = [];
    const hostsPred: boolean[] = [];
    const hostsTrue: boolean[] = [];
    let rejected = 0;
    let proposed = 0;

    for (const [venueKey, pred] of evaluated) {
      const venueLabels = labelsByVenue.get(venueKey)!;
      const hosts = venueLabels.some((l) => l.hosts_private_events);
      hostsPred.push(pred.hostsPrivateEvents);
      hostsTrue.push(hosts);
      rejected += pred.rejected;
      proposed += pred.proposed;

      const labelledRooms = venueLabels.filter((l) => l.hosts_private_events && l.max_capacity != null);
      for (const label of labelledRooms) {
        const match = matchRoom(label, labelledRooms, pred.rooms);
        roomOutcomes.push({
          exact: match != null && match.maxCapacity === label.max_capacity,
          within10: match != null && withinTolerance(match.maxCapacity, label.max_capacity!),
        });
      }
      for (const room of pred.rooms) {
        const label =
          labelledRooms.find((l) => sameRoom(room.roomName, l.room_name)) ??
          (labelledRooms.length === 1 ? labelledRooms[0] : null);
        const correct = hosts && label != null && withinTolerance(room.maxCapacity, label.max_capacity!);
        confidences.push(room.confidence);
        correctness.push(correct);
        tier[room.trust] ??= { n: 0, correct: 0 };
        tier[room.trust].n += 1;
        tier[room.trust].correct += Number(correct);
      }
    }

    const rate = (k: number, n: number) => (n === 0 ? null : Math.round((k / n) * 1000) / 1000);
    results[system] = {
      venuesEvaluated: evaluated.length,
      venuesSkipped: skipped,
      capacityAccuracy: {
        labelledRooms: roomOutcomes.length,
        exact: rate(roomOutcomes.filter((o) => o.exact).length, roomOutcomes.length),
        within10pct: rate(roomOutcomes.filter((o) => o.within10).length, roomOutcomes.length),
      },
      privateEvents: precisionRecallF1(hostsPred, hostsTrue),
      groundingRejectionRate: system === "llm" || system === "combined" ? rate(rejected, proposed) : null,
      perTier: Object.fromEntries(
        Object.entries(tier).map(([t, v]) => [t, { n: v.n, accuracy: rate(v.correct, v.n) }])
      ),
      ece: confidences.length ? Math.round(expectedCalibrationError(confidences, correctness) * 10000) / 10000 : null,
    };
  }

  writeFileSync(join(EVAL_DIR, "results.json"), JSON.stringify(results, null, 2) + "\n");
  writeFileSync(join(EVAL_DIR, "features.jsonl"), featureRows.join("\n") + (featureRows.length ? "\n" : ""));
  console.log(JSON.stringify(results, null, 2));
  console.log(`\nwrote eval/results.json and eval/features.jsonl (${featureRows.length} rows)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
