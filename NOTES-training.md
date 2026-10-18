# Training pipeline: notes

Working log for the offline data and training pipeline (branch `feat/training-pipeline`). It records the procedure, API differences, prices, caps, decisions and status.

## Status (2026-10-18)

- **Built and tested:** every step, 1 to 13 (`scripts/data/`, `ml/`), the app wiring (`model-scoring.ts`, the placeholder guard) and the parity test.
- **Verified end to end offline:** `npm run data:dryrun` runs all 13 steps on a synthetic world of 970 venues with known room sizes (results below).
- **Verified live:** Google Places Text Search (Step 2, three venues) and the Claude teacher (Step 5) on synthetic venues, through both the normal API and the Message Batches API.
- **Not run on real data yet.** This session's network policy refuses `api.x.ai`, `api.firecrawl.dev`, `huggingface.co` and the venue websites. The real run needs a session whose environment allows those hosts. `src/data/*.json` are still placeholders, so the app runs the v0 behaviour.

## How to run it for real

Prerequisites: network access to `api.x.ai`, `api.firecrawl.dev`, `huggingface.co`, `places.googleapis.com`, `api.anthropic.com` and the venue websites (any host). Keys come from the environment or `.env.local`: `HF_TOKEN`, `GOOGLE_PLACES_API_KEY`, `FIRECRAWL_API_KEY`, `XAI_API_KEY`, `ANTHROPIC_API_KEY`. Python: `pip install -r ml/requirements.txt`.

| Step | Command | Stop point |
| --- | --- | --- |
| 1 | `npx tsx scripts/data/01_sample_venues.ts` | |
| 2 | `npx tsx scripts/data/02_enrich_google.ts` | |
| 3 | `npx tsx scripts/data/03_snapshot.ts --pilot` | **STOP 1:** pilot forecast in `eval/results/snapshot_pilot_forecast.json`; decide on PDF parsing (`--pdf`) |
| 3 | `... --full`, then `... --replace`, then Step 2 again for the replacements | Needs ≥ 500 venues with `fetch_outcome = ok` |
| 4 | `npx tsx scripts/data/04_extract_student.ts` | |
| 5 | `python3 scripts/data/05_label_teacher.py --pilot` | **STOP 2:** check the 20 pilot labels and the cost per venue |
| 5 | `python3 scripts/data/05_label_teacher.py --batch` (resume with `--collect`) | |
| 6 | `npx tsx scripts/data/06_build_review_sheets.ts`; each reviewer opens `eval/review/index.html`, loads their sheet and exports `review_<name>.csv` into `eval/review/` | Human work: about 40 venues per reviewer |
| 7 | `npx tsx scripts/data/07_ingest_review.ts` (fill `resolved_value` in `eval/review/conflicts.csv` if it stops) | **STOP 3:** teacher quality gate |
| 8 | `npx tsx scripts/data/08_build_tables.ts` | |
| 9–11 | `python3 ml/train_confidence.py`, `python3 ml/train_discovery.py`, `python3 ml/build_fit_prior.py` | **STOP 4:** metrics vs. baselines; Yelp pretraining yes or no; ship or not |
| 12 | `python3 ml/export_fixtures.py`, then `npm test` | The parity test fails if a trained model ships without its fixture |
| 13 | `npx tsx scripts/data/09_eval_extraction.ts`, `python3 ml/evaluate.py` | `eval/results/summary.md`; fill in `eval/DATA_CARD.md` |

Every script resumes from where it stopped, writes atomically, appends to `eval/run_manifest.jsonl` and aborts cleanly at its cap: Google 900 calls (`GOOGLE_TEXT_SEARCH_CAP`), Firecrawl 900 credits plus a 150-credit PDF sub-cap, xAI $25, Anthropic $15.

## Models and prices

| Role | Model | Price per 1M tokens (in / out) | Verified |
| --- | --- | --- | --- |
| Student | `grok-4.7` (`XAI_MODEL`); Step 4 checks it against `GET /v1/models` first | $2 / $6 (`XAI_PRICE_*` to override) | No: `api.x.ai` blocked here |
| Teacher (default) | `claude-sonnet-5-5` (`TEACHER_MODEL`) | $2 / $10; Batches 50% off | Yes, live (below) |
| Teacher (option) | `claude-opus-5-5` | $4 / $20; Batches 50% off | Model list only |

## Live checks

- **Google Places Text Search (New):** three calls. Perbacco matched at 19 m (price 3, rating 4.5, 1,060 reviews), Kokkari matched, and a made-up venue got no match. A resumed run made 0 calls.
- **Claude teacher, normal API:** three synthetic venues. All three labels matched the ground truth exactly: rooms, seated and standing figures, full buyout, total seats and hosts-private-events. Every quote passed the grounding check. Usage was about 2,000–2,300 input and 70–270 output tokens, about $0.005–0.007 per venue.
- **Claude teacher, Message Batches API:** one 3-venue batch through `--batch`. It ended in about 4 minutes. All three labels were correct, including a combined room ("Salon+Terrace", rule 6), at $0.0024–0.0035 per venue. Total live Anthropic spend for both tests: $0.05.
- **Forecast for the real teacher run:** about 550 venues × ~$0.003 (batch) ≈ $2–4, well under the $15 cap. Output allowance per venue: 1.5 × the pilot's 95th percentile, at least 2,000 tokens.

## API differences from the docs and from memory

- **scikit-learn 1.9:** `LogisticRegression(penalty="l2")` is deprecated (since 1.8). Use `l1_ratio=0` for L2. `CalibratedClassifierCV(..., ensemble=False)` gives one (model, sigmoid) pair, so `a` and `b` can be exported.
- **Anthropic (Sonnet 5.5):** rejects non-default `temperature` and a forced `tool_choice`. Strict JSON goes through `output_config.format` (`json_schema`), and `output_config.effort` bounds output. `fallbacks` is rejected on the Batches API. This session's environment sets its own `ANTHROPIC_BASE_URL`, so the teacher client pins `https://api.anthropic.com` (or `TEACHER_BASE_URL` for the dry run).
- **Google Places:** the Step 2 field mask includes `rating` and `userRatingCount`, which bills at the Enterprise SKU. Secondary sources give 1,000 free Enterprise calls a month; Google's pricing page was unreachable here, so confirm it. Planned usage is about 610 calls (608 in the dry run). The app's Nearby Search already requests `websiteUri`, `nationalPhoneNumber` and `priceLevel`, which are Enterprise fields too. Adding `rating`, `userRatingCount` and `primaryType` for the discovery prior should therefore not change its SKU (unverified for the same reason).
- **Node fetch through the proxy** needs `NODE_USE_ENV_PROXY=1` in this environment.

## Bugs the dry run found (fixed)

1. **Word gluing in `textFromHtml` (app code).** Text from adjacent block elements ran together ("for sale" + "Buy" became "saleBuy"). Parked-domain pages were never detected, and capacity phrases split across list items could merge. Block elements now end a word; tests added.
2. **Teacher batch reserve.** `--batch` reserved every venue at the 16,000-token `max_tokens` (about $45 for 527 venues), so it refused to start under the $15 cap. It now reserves the pilot-measured output allowance and submits 100 venues per batch, charging each batch at its real cost before reserving the next.
3. **xAI per-venue cost.** Venues run four at a time, and each venue's cost was taken from the shared ledger's change, which counted the other venues' calls too. Each venue now sums its own calls.
4. Python atomic writes created 0600 files; they are now 0644.

## Dry run (synthetic, `npm run data:dryrun`)

970 synthetic venues across the four cities. Each has a website (static, JavaScript-only, bot challenge, robots-blocked, parked, PDF-only, several locations, non-English) and a Google record. Mock models read the page text with seeded noise. The numbers below check the code. They say nothing about real venues.

- **Funnel:** 560 sampled and 48 replacements; 547 ok, 16 robots-blocked, 20 failed fetches, 25 parked.
- **Spend:** 102 Firecrawl credits, 608 Google calls.
- **Teacher:** 532 labeled, 15 unclear.
- **Gold:** 130 venues, 24 double-reviewed, kappa 0.92; one conflict, resolved. The gate passed (room precision 0.99, venue accuracy 0.975).
- **Tables:** 425 confidence train rows and 387 test; 285 discovery train venues and 254 test; 146 fit-prior venues. All leakage assertions held.
- **Extraction on gold, F1:** v0 regex maximum 0.31; regex candidates 0.68; one Grok read 0.67; three grounded reads 0.89.
- **Confidence model, test (gold) log loss:** 0.17, against 0.61 for B0, 0.23 for B1 and 0.56 for B2; ECE 0.05.
- **Discovery prior, test (gold) AUC:** 0.75 pre-fetch and 0.78 post-fetch, against 0.71 for v0.
- **Parity:** TypeScript matches scikit-learn within 1e-6 on 30 rows per model; the fit-prior interpolation matches within 1e-9. The committed fixture `src/lib/discovery/__fixtures__/model-parity.json` comes from this dry run. A real run overwrites it, and the test requires it to match the shipped model versions.

## Decisions

- **Self-consistency:** option A. Production runs the same three reads at temperature 0.7 as training (`extraction-config.ts`).
- **Placeholder guard:** while `src/data/confidence-model.json` is a placeholder, no room is scored. Ranking uses the v0 tier weights, and "% likely to fit" is hidden. A stored score counts only if the loaded model's version produced it (`capacityBelief`).
- **What the confidence model scores:** a room whose displayed figure is the LLM's own modal read. That is what each training row measured. Regex-only rooms, estimates and rooms showing the regex figure after a disagreement keep their tier weight.
- **Discovery prior at runtime:** the `pre_fetch` variant orders candidates before the per-run caps. `post_fetch` is exported and evaluated, but not wired; it would only reorder LLM reads after the homepages are fetched.
- **Fit prior:** a trained table replaces the hand-set logistic curve when present. The venue's bucket comes from its category text (`bucketFromText`).
- **Small data:** if the minority class has fewer than 30 rows, the confidence model drops to 3 features. Below 15 it is not trained, and the app keeps the v0 weights.
- **Removed:** the first evaluation harness (`scripts/eval-snapshot.ts`, `eval-extraction.ts`, `eval-agreement.ts`, `scripts/train_confidence.py`, `requirements-dev.txt`, label templates). The pipeline above replaces it. `scripts/eval-ranking.ts` (NDCG@5) stays.

## Open items for the real run

1. A session with network access to the hosts above.
2. Confirm the Google free monthly cap for Text Search Enterprise and record it here.
3. STOP 1–4 decisions: PDF parsing; teacher pilot review; the gate (or accepting a documented failure); shipping the models and whether to try Yelp pretraining.
4. Delete `eval/google_features.csv` 30 days after collection and record the date in `eval/DATA_CARD.md`.
