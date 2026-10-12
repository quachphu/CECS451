# Evaluation harness

Measures the AI core (extraction → grounding → confidence → ranking) against
human labels, for the Phase 2/3 reports. Everything here runs offline once
snapshots and labels exist; nothing in `eval/` is used by the app.

Only templates and code are committed. Snapshots (venue page text),
candidate metadata (Places-derived), filled-in labels/judgments and outputs
are gitignored — see `eval/.gitignore`.

## Files

| File | What it is |
| --- | --- |
| `labels.template.csv` | Ground-truth schema. Copy to `labels.csv` and fill in. |
| `urls.template.csv` | Venues to snapshot. Copy to `urls.csv`. |
| `ranking-judgments.template.csv` | Graded 0–3 relevance per venue per scenario. Copy to `ranking-judgments.csv`. |
| `metrics.ts` | NDCG@k [P8], Cohen's kappa [P9], ECE [P5], P/R/F1 — unit-tested against scikit-learn. |
| `baselines.ts` | v0 extraction (largest regex number) and v0 ranking formula, kept as pure functions. |
| `csv.ts` | Dependency-free CSV reader. |

### Label schema (`labels.csv`)

One row per labelled room (a venue that hosts no private events gets one row
with empty room fields):

| Column | Meaning |
| --- | --- |
| `venue_key` | Stable id, same as in `urls.csv` (e.g. `carmines-times-square`) |
| `city` | `nyc` / `sf` / `waikiki` / … |
| `category` | Venue category as discovered (`restaurant`, `bar`, `banquet hall`, …) |
| `url` | The page the labeler read |
| `hosts_private_events` | `1` if the venue's own site says it hosts private events/group dining, else `0` |
| `room_name` | The room's name as written on the site |
| `max_capacity` / `min_capacity` | Guests, as stated on the site (blank if not stated) |
| `min_spend_usd` | Food & beverage minimum, if stated |
| `evidence_quote` | The sentence that states it, verbatim |
| `labeler` | Who labelled the row (two labelers per venue for agreement) |

Label from the venue's own site only, the same evidence the system sees. If a
figure isn't stated, leave it blank rather than estimating.

## Workflow

```bash
# 1. Snapshot pages (live; honours robots.txt; Firecrawl credits if FIRECRAWL_API_KEY is set)
npx tsx scripts/eval-snapshot.ts eval/urls.csv

# 2. Two labelers fill eval/labels.csv, then check agreement (Cohen's kappa on hosts_private_events)
npx tsx scripts/eval-agreement.ts eval/labels.csv alice bob

# 3. Compare v0 / regex-only / LLM-only / combined extraction (offline; the model's
#    answers are cached in eval/snapshots/<key>.llm.json, fetched once if XAI_API_KEY is set)
npx tsx scripts/eval-extraction.ts           # -> eval/results.json, eval/features.jsonl

# 4. Refit the confidence model and the discovery prior from those labels
pip install -r requirements-dev.txt
python3 scripts/train_confidence.py --dry-run          # report ECE + reliability table only
python3 scripts/train_confidence.py                    # writes src/data/confidence-model.json
python3 scripts/train_confidence.py --target prior     # writes src/data/discovery-prior.json

# 5. Ranking: export each scenario's venues once, then score NDCG@5 offline
npx tsx scripts/eval-ranking.ts --export     # needs Supabase env; -> eval/ranking-venues.json
npx tsx scripts/eval-ranking.ts              # -> eval/ranking-results.json
```

## What `results.json` reports (per system)

- **capacityAccuracy**: per labelled room, exact and within ±10% of the labelled `max_capacity`. A predicted room is paired with the labelled one by room name, or as the venue's only room.
- **privateEvents**: precision / recall / F1 of "hosts private events" per venue [P1].
- **groundingRejectionRate**: share of model-proposed rooms whose evidence quote was not on the page or did not state the number. This is the hallucination proxy [P2, P3].
- **perTier**: predicted rooms per trust tier, with the share that were correct (±10%).
- **ece**: Expected Calibration Error of each room's stored confidence against correctness (10 bins) [P4, P5]. For v0 the tier weight stands in for confidence.

`v0` is the original "largest number on the page" logic, `regex` is the new candidate-based regex alone, `llm` is grounded LLM extraction alone, and `combined` is the shipped system.
