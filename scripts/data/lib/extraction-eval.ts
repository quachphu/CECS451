/**
 * Room-level extraction scoring against gold rooms (Step 13): one-to-one
 * matching per stated figure, a room correct when within 10% of its match.
 */
import { labelFigures, matchOneToOne, correctness, type ExtractedRoom, type LabelRoom } from "./matching";

export type ExtractionScore = {
  venues: number;
  predicted: number;
  gold_figures: number;
  matched: number;
  correct: number;
  precision: number | null;
  recall: number | null;
  f1: number | null;
  accuracy_within_10pct: number | null;
  invented_rate: number | null;
};

export function scoreExtraction(
  venues: Array<{ predicted: ExtractedRoom[]; gold: LabelRoom[]; totalSeats: number | null }>
): ExtractionScore {
  let predicted = 0;
  let matched = 0;
  let correct = 0;
  let gold = 0;
  for (const v of venues) {
    gold += v.gold.reduce((n, r) => n + labelFigures(r).length, 0);
    for (const { room, match } of matchOneToOne(v.predicted, v.gold, v.totalSeats)) {
      predicted++;
      if (match) matched++;
      correct += correctness(room.capacity, match).y;
    }
  }
  const ratio = (a: number, b: number) => (b ? a / b : null);
  const precision = ratio(correct, predicted);
  const recall = ratio(Math.min(correct, gold), gold);
  return {
    venues: venues.length,
    predicted,
    gold_figures: gold,
    matched,
    correct,
    precision,
    recall,
    f1: precision != null && recall != null && precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : null,
    accuracy_within_10pct: ratio(correct, matched),
    invented_rate: ratio(predicted - matched, predicted),
  };
}
