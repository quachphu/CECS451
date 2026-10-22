# Evaluation and training data

Everything here is offline. Nothing in `eval/`, `scripts/data/` or `ml/` runs in the web app; the app only reads the exported model JSON in `src/data/`.

## Training pipeline (Steps 1–13)

The training labels are human labels by Thien Phu Quach. In short:

| Step | Command | Writes |
| --- | --- | --- |
| 1 Sample 560 venues | `npx tsx scripts/data/01_sample_venues.ts` | `venues.csv`, `venues_reserve.csv` |
| 2 Google enrichment | `npx tsx scripts/data/02_enrich_google.ts` | `google_features.csv` (gitignored, 30-day retention) |
| 3 Save pages | `npx tsx scripts/data/03_snapshot.ts --pilot`, then `--full`, then `--replace` | `snapshots/` (gitignored), `venue_index.csv` |
| 4 Student extraction | `npx tsx scripts/data/04_extract_student.ts` | `extractions.jsonl`, `extraction_venues.jsonl` |
| 5 Human labels | `python3 scripts/data/05_label_teacher.py --pilot`, then `--batch` | `teacher_labels.jsonl`. Labeled by Thien Phu Quach |
| 6 Review sheets | `npx tsx scripts/data/06_build_review_sheets.ts`, then open `review/index.html` | `review/assignments.csv`, `gold_venues.csv` |
| 7 Ingest reviews | `npx tsx scripts/data/07_ingest_review.ts` | `gold_labels.csv`, `results/teacher_quality.json` |
| 8 Tables | `npx tsx scripts/data/08_build_tables.ts` | `train_*.csv`, `test_*.csv`, `fit_prior_venues.csv`, `results/data_funnel.json` |
| 9 Confidence model | `python3 ml/train_confidence.py` | `src/data/confidence-model.json`, `results/confidence_*` |
| 10 Discovery prior | `python3 ml/train_discovery.py` | `src/data/discovery-prior.json`, `results/discovery_*` |
| 11 Fit prior | `python3 ml/build_fit_prior.py` | `src/data/fit-priors.json`, `results/fit_prior*` |
| 12 Parity fixture | `python3 ml/export_fixtures.py` | `src/lib/discovery/__fixtures__/model-parity.json` |
| 13 Extraction table and summary | `npx tsx scripts/data/09_eval_extraction.ts`, `python3 ml/evaluate.py` | `results/extraction_eval.json`, `results/summary.md` |

Every script is resumable, writes atomically, appends a line to `run_manifest.jsonl` and stops at its spend cap. Python needs `pip install -r ml/requirements.txt`.

**Dry run.** `npm run data:dryrun` runs all of the above offline on a synthetic world of 970 venues with known room sizes (`scripts/data/dryrun/`). A shim answers the venue sites, Google, Firecrawl and xAI; a local server stands in for the Anthropic API; simulated reviewers fill the review sheets. It never touches `src/data/` or the network.

**Committed:** venue IDs, labels, train/test tables, model JSON and aggregate results. **Never committed:** `snapshots/`, `google_features.csv`, review sheets, caches and spend ledgers (see `.gitignore` here and at the root).

## Files kept from the first evaluation

| File | What it is |
| --- | --- |
| `metrics.ts` | NDCG@k, Cohen's kappa, ECE, precision/recall/F1, unit-tested against scikit-learn |
| `baselines.ts` | v0 extraction (largest number on the page), v0 trust weights, v0 discovery prior and v0 ranking formula |
| `csv.ts` | Dependency-free CSV reader |
| `ranking-judgments.template.csv` | Graded 0–3 relevance per venue per scenario, for `scripts/eval-ranking.ts` |
| `review/` | The reviewer tool (`index.html`) and its instructions |

## Ranking evaluation

NDCG@5 for distance-only, the v0 formula and the expected-utility ranking, against graded team judgments:

```bash
cp eval/ranking-judgments.template.csv eval/ranking-judgments.csv   # fill in grades
npx tsx scripts/eval-ranking.ts --export     # needs Supabase env; writes eval/ranking-venues.json
npx tsx scripts/eval-ranking.ts              # writes eval/ranking-results.json
```
