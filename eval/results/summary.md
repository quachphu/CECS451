# Training pipeline results

Data folder: `/Users/phuthienquach/Downloads/CECS451/eval`.

## 1. Data funnel

| Step | NYC | SF | Honolulu | LA | all |
| --- | ---: | ---: | ---: | ---: | ---: |
| sampled | 145 | 145 | 100 | 170 | 560 |
| replacements drawn | 25 | 25 | 17 | 28 | 95 |
| no or invalid website | 0 | 0 | 0 | 0 | 0 |
| robots blocked | 49 | 44 | 34 | 59 | 186 |
| fetch failed | 35 | 35 | 21 | 41 | 132 |
| parked or closed | 0 | 1 | 0 | 1 | 2 |
| ok | 86 | 90 | 62 | 97 | 335 |
| extraction failed | 1 | 5 | 2 | 3 | 11 |
| teacher unclear | 3 | 1 | 2 | 7 | 13 |
| teacher labeled | 83 | 89 | 60 | 90 | 322 |
| gold | 34 | 34 | 23 | 39 | 130 |
| confidence train rows | 12 | 13 | 9 | 0 | 34 |
| confidence test rows | 4 | 4 | 1 | 29 | 38 |
| discovery train rows | 23 | 24 | 12 | 0 | 59 |
| discovery test rows | 10 | 18 | 8 | 38 | 74 |
| fit prior venues | 5 | 7 | 5 | 0 | 17 |

Exclusions: confidence {'label_unclear': 1, 'extraction_failed': 16}; discovery {'hosts_unknown': 202}.

## 2. Teacher quality (gold venues)

On 2026-10-21, Thien Phu Quach reviewed the teacher labels for all labeled venues and confirmed them as correct. The review was not recorded row by row.

The gate passed on that attestation. Gold venues use the teacher labels with `label_source = teacher_human_confirmed`. Per-item human accuracy and Cohen's kappa are not reported.

Label quality is the agreement with a second teacher, `claude-opus-5-5`, on the same prompt through the Batch API. The estimate before the call was $3.36 expected and $9.50 worst-case, against $13.21 remaining. The run cost $3.86. The ledger is now $5.65 of $15.

| Agreement, 335 venues | Value |
| --- | ---: |
| hosts_private_events | 0.854 |
| status | 0.979 |
| Sonnet figures within 10% of an Opus figure | 0.878 (108 of 123) |
| Opus figures within 10% of a Sonnet figure | 0.965 (109 of 113) |

## 3. Extraction on gold

**All gold**

| Method | Precision | Recall | F1 | Within 10% | Invented-number rate | Predicted |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| v0 regex max | – | – | – | – | – | 0 |
| Regex candidates | – | – | – | – | – | 0 |
| Grok, single read | – | – | – | – | – | 0 |
| Grok + grounding + self-consistency | – | – | – | – | – | 0 |

**LA gold**

| Method | Precision | Recall | F1 | Within 10% | Invented-number rate | Predicted |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| v0 regex max | – | – | – | – | – | 0 |
| Regex candidates | – | – | – | – | – | 0 |
| Grok, single read | – | – | – | – | – | 0 |
| Grok + grounding + self-consistency | – | – | – | – | – | 0 |

Room-level, per stated figure; correct = within 10% of the matched gold figure. v0 category estimates are left out of v0_regex_max (it guessed a number when none was on the page). Estimates left out: 0.

## 4. Confidence model vs. baselines

Not trained: the minority class has 0 rows (< 15). The app keeps the v0 tier weights (B0) and does not show '% likely to fit'.

**Out of fold (train)**

| Model | n | Log loss [95% CI] | Brier | AUC | ECE (width) | ECE (mass) | Accuracy |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| B0_v0_trust | 34 | 0.310 [0.175, 0.556] | 0.092 [0.038, 0.193] | – | 0.232 [0.142, 0.390] | 0.232 | 0.912 |
| B1_evidence_lookup | 34 | 0.254 [0.179, 0.340] | 0.055 [0.031, 0.087] | – | 0.219 [0.161, 0.285] | 0.219 | 1.000 |
| B2_constant | 34 | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | – | 0.000 [0.000, 0.000] | 0.000 | 1.000 |

**Test (gold)**

| Model | n | Log loss [95% CI] | Brier | AUC | ECE (width) | ECE (mass) | Accuracy |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| B0_v0_trust | 27 | 0.306 [0.152, 0.962] | 0.091 [0.029, 0.376] | 0.940 [0.500, 0.993] | 0.181 [0.085, 0.567] | 0.196 | 0.889 |
| B1_evidence_lookup | 27 | 0.253 [0.062, 1.322] | 0.067 [0.004, 0.429] | 0.760 [0.600, 0.817] | 0.037 [0.020, 0.433] | 0.114 | 0.926 |
| B2_constant | 27 | 2.558 [0.000, 17.270] | 0.074 [0.000, 0.500] | 0.500 [0.500, 0.500] | 0.074 [0.000, 0.500] | 0.074 | 0.926 |

**Test (LA gold)**

| Model | n | Log loss [95% CI] | Brier | AUC | ECE (width) | ECE (mass) | Accuracy |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| B0_v0_trust | 18 | 0.105 [0.105, 0.105] | 0.010 [0.010, 0.010] | – | 0.100 [0.100, 0.100] | 0.100 | 1.000 |
| B1_evidence_lookup | 18 | 0.071 [0.071, 0.071] | 0.005 [0.005, 0.005] | – | 0.068 [0.068, 0.068] | 0.068 | 1.000 |
| B2_constant | 18 | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | – | 0.000 [0.000, 0.000] | 0.000 | 1.000 |

**Test (LA teacher-labeled)**

| Model | n | Log loss [95% CI] | Brier | AUC | ECE (width) | ECE (mass) | Accuracy |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| B0_v0_trust | 11 | 0.489 [0.190, 1.204] | 0.165 [0.047, 0.490] | – | 0.345 [0.146, 0.700] | 0.345 | 0.818 |
| B1_evidence_lookup | 11 | 0.075 [0.067, 0.080] | 0.005 [0.004, 0.006] | – | 0.072 [0.065, 0.077] | 0.072 | 1.000 |
| B2_constant | 11 | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | – | 0.000 [0.000, 0.000] | 0.000 | 1.000 |

## 5. Discovery prior vs. v0 order

**Out of fold (train)**

| Model | n | Log loss [95% CI] | Brier | AUC | ECE (width) | ECE (mass) | Accuracy |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| pre_fetch (C=0.3) | 59 | 0.499 [0.372, 0.640] | 0.160 [0.108, 0.213] | 0.726 [0.547, 0.887] | 0.111 [0.086, 0.228] | 0.151 | 0.780 |
| post_fetch (C=0.3) | 59 | 0.498 [0.371, 0.639] | 0.159 [0.108, 0.213] | 0.729 [0.559, 0.887] | 0.134 [0.098, 0.238] | 0.125 | 0.763 |
| v0 hand-set prior | 59 | 0.552 [0.424, 0.691] | 0.184 [0.134, 0.237] | 0.703 [0.541, 0.850] | 0.123 [0.102, 0.252] | 0.152 | 0.729 |

**Test (gold)**

| Model | n | Log loss [95% CI] | Brier | AUC | ECE (width) | ECE (mass) | Accuracy |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| pre_fetch (C=0.3) | 51 | 0.529 [0.410, 0.659] | 0.181 [0.128, 0.238] | 0.777 [0.630, 0.894] | 0.113 [0.049, 0.227] | 0.132 | 0.667 |
| post_fetch (C=0.3) | 51 | 0.527 [0.408, 0.656] | 0.180 [0.128, 0.238] | 0.781 [0.634, 0.898] | 0.121 [0.057, 0.240] | 0.137 | 0.686 |
| v0 hand-set prior | 51 | 0.571 [0.432, 0.723] | 0.194 [0.137, 0.257] | 0.763 [0.618, 0.896] | 0.195 [0.152, 0.320] | 0.166 | 0.765 |

**Test (LA gold)**

| Model | n | Log loss [95% CI] | Brier | AUC | ECE (width) | ECE (mass) | Accuracy |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| pre_fetch (C=0.3) | 15 | 0.496 [0.299, 0.719] | 0.166 [0.079, 0.265] | 0.864 [0.597, 1.000] | 0.150 [0.070, 0.345] | 0.316 | 0.667 |
| post_fetch (C=0.3) | 15 | 0.485 [0.287, 0.703] | 0.161 [0.074, 0.258] | 0.864 [0.597, 1.000] | 0.174 [0.102, 0.366] | 0.309 | 0.733 |
| v0 hand-set prior | 15 | 0.442 [0.288, 0.637] | 0.140 [0.079, 0.223] | 0.920 [0.750, 1.000] | 0.296 [0.216, 0.414] | 0.296 | 0.933 |

**Test (LA teacher-labeled)**

| Model | n | Log loss [95% CI] | Brier | AUC | ECE (width) | ECE (mass) | Accuracy |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| pre_fetch (C=0.3) | 23 | 0.484 [0.299, 0.685] | 0.161 [0.082, 0.245] | 0.651 [0.381, 0.955] | 0.125 [0.058, 0.287] | 0.209 | 0.696 |
| post_fetch (C=0.3) | 23 | 0.481 [0.298, 0.682] | 0.159 [0.081, 0.244] | 0.651 [0.381, 0.955] | 0.124 [0.061, 0.285] | 0.207 | 0.739 |
| v0 hand-set prior | 23 | 0.368 [0.247, 0.501] | 0.111 [0.062, 0.167] | 0.868 [0.655, 1.000] | 0.159 [0.093, 0.269] | 0.210 | 0.913 |

**Yield on all test venues** (share of top-K that host private events)

| Ranking | Model | v0 prior | Random |
| --- | ---: | ---: | ---: |
| pre_fetch, yield@10 (top 10) | 1.000 | 0.900 | 0.756 |
| pre_fetch, yield@25 (top 25) | 0.960 | 0.960 | 0.759 |
| post_fetch, yield@10 (top 10) | 1.000 | 0.900 | 0.756 |
| post_fetch, yield@25 (top 25) | 0.960 | 0.960 | 0.759 |

## 6. Fit prior

| Bucket | n | q(30) | q(50) | q(200) |
| --- | ---: | ---: | ---: | ---: |
| fine_dining | 0 | 0.94 | 0.82 | 0.59 |
| casual_restaurant | 4 | 0.97 | 0.79 | 0.44 |
| steakhouse_grill | 3 | 0.96 | 0.76 | 0.49 |
| bar_lounge | 6 | 0.97 | 0.92 | 0.72 |
| hotel | 2 | 0.82 | 0.73 | 0.56 |
| event_space | 1 | 0.95 | 0.85 | 0.66 |
| fast_casual_cafe | 1 | 0.95 | 0.85 | 0.66 |
| all (global) | 17 | 0.94 | 0.82 | 0.59 |

alpha = 5.0. q is conditional on a published room size: venues that host events but publish no number are not counted.

| Headcount | Brier (bucket q) | Brier (global q) |
| --- | ---: | ---: |
| 10 | 0.000 | 0.000 |
| 20 | 0.005 | 0.003 |
| 30 | 0.103 | 0.114 |
| 40 | 0.145 | 0.157 |
| 50 | 0.147 | 0.152 |
| 75 | 0.229 | 0.221 |
| 100 | 0.247 | 0.254 |
| 150 | 0.228 | 0.241 |
| 200 | 0.249 | 0.247 |
| 300 | 0.240 | 0.272 |

## 7. LA (new-city generalization)

LA rows are shown in their own tables above: "Test (LA gold)" is the strictest test (human labels, a city never trained on); "Test (LA teacher-labeled)" covers the rest of LA with teacher labels.

## 8. Cost and time

| Script | Status | Spend | Seconds | Models |
| --- | ---: | ---: | ---: | ---: |
| 01_sample_venues | ok | – | 531.2 | source=hf://datasets/foursquare/fsq-os-places/release/dt=2026-10-15/places/parquet/*.parquet |
| 02_enrich_google | ok | google_text_search_calls 560 | 175.1 | google_endpoint=places:searchText (New) |
| 03_snapshot:pilot | ok | firecrawl_credits 4, firecrawl_pdf_credits 0 | 12.6 | user_agent=private-dining-finder/0.2 (CSULB CECS 451 research) |
| 03_snapshot:full | ok | firecrawl_credits 31, firecrawl_pdf_credits 0 | 137.3 | user_agent=private-dining-finder/0.2 (CSULB CECS 451 research) |
| 03_snapshot:replace | ok | firecrawl_credits 49, firecrawl_pdf_credits 0 | 274.7 | user_agent=private-dining-finder/0.2 (CSULB CECS 451 research) |
| 02_enrich_google | ok | google_text_search_calls 655 | 28.9 | google_endpoint=places:searchText (New) |
| 04_extract_student | ok | xai_usd_total 0.5436, xai_usd_this_run 0.5436 | 44.6 | student=grok-4.7, k=3, temperature=0.7, available_models=grok-4.20-0309-non-reasoning grok-4.20-0309-reasoning grok-4.20-multi-agent-0309 grok-4.3 grok-4.5 grok-4.6 grok-4.7 grok-build-0.1 grok-imagine-image grok-imagine-image-2.0 grok-imagine-image-quality grok-imagine-video grok-imagine-video-1.5 grok-imagine-video-1.5-lite |
| 04_extract_student | ok | xai_usd_total 9.25, xai_usd_this_run 8.706 | 974.9 | student=grok-4.7, k=3, temperature=0.7, available_models=grok-4.20-0309-non-reasoning grok-4.20-0309-reasoning grok-4.20-multi-agent-0309 grok-4.3 grok-4.5 grok-4.6 grok-4.7 grok-build-0.1 grok-imagine-image grok-imagine-image-2.0 grok-imagine-image-quality grok-imagine-video grok-imagine-video-1.5 grok-imagine-video-1.5-lite |
| 05_label_teacher:pilot | ok | anthropic_usd_total 0.2189 | 29.9 | teacher=claude-sonnet-5-5, prompt_version=teacher_v1, effort=medium |
| 05_label_teacher:batch | ok | anthropic_usd_total 1.79 | 1033.7 | teacher=claude-sonnet-5-5, prompt_version=teacher_v1, effort=medium |
| 06_build_review_sheets | ok | – | 0.1 | – |
| 08_build_tables | ok | – | 0.1 | – |
| ml/train_confidence.py | skipped | – | 3.9 | – |
| ml/train_discovery.py | ok | – | 8.0 | discovery_prior=trained-2026-10-18 |
| ml/build_fit_prior.py | ok | – | 0.3 | fit_prior=trained-2026-10-18 |
| ml/evaluate.py | ok | – | 0.1 | – |
| 09_eval_extraction | ok | – | 0.0 | – |
| ml/evaluate.py | ok | – | 0.0 | – |
| ml/train_confidence.py | skipped | – | 4.2 | – |
| ml/train_discovery.py | ok | – | 24.1 | discovery_prior=trained-2026-10-20 |
| ml/build_fit_prior.py | ok | – | 0.4 | fit_prior=trained-2026-10-20 |
| 08_build_tables | ok | – | 0.1 | – |
| ml/evaluate.py | ok | – | 0.0 | – |
| 08_build_tables | ok | – | 0.1 | – |
| ml/train_confidence.py | skipped | – | 7.1 | – |
| ml/train_discovery.py | ok | – | 26.0 | discovery_prior=trained-2026-10-21 |
| ml/build_fit_prior.py | ok | – | 0.4 | fit_prior=trained-2026-10-21 |

- google_text_search: 655 of 900 calls (655 calls)
- firecrawl: 49 of 900 credits (153 calls)
- xai: 9.25 of 25 usd (971 calls)
- anthropic: 1.79 of 15.0 usd (335 calls)

## 9. Candidate pass (2026-10-21)

Saved pages were turned into one row per candidate number. Gold venues and LA domains stayed out of training. Nothing was written to `src/data/`.

| Table | Train | Notes |
| --- | ---: | --- |
| Candidate numbers | 530 rows, 58 positives, 15 venues | Test 571 rows. A positive is within 10% of a teacher seated or standing figure. |
| Event-content discovery | 147 venues, 46 positives | Readable page has a private-dining page, event wording, or an external event link. Pre-fetch features only. |
| Hosts-yes fit prior | 43 venues, 16 with a published room | Bucket counts: casual restaurant 10, bar/lounge 16, steakhouse 6, hotel 3, event space 4, fast casual 4, fine dining 0. Every bucket is under 25, so each uses the global curve. |

**Selection.** Counting every venue makes every method look weak, because most pages have no teacher room. On the 10 gold venues that do have a correct number, the model picks it 80% of the time. The votes-plus-quote heuristic picks it 90%, the largest regex hit 50%, and the current pipeline winner 40%. The model does not beat the heuristic.

**Calibration against the tier weights.** On the 22 gold numbers the pipeline would show, 20 are correct. The model's log loss is 0.121 and the tier weight's is 0.278. The model predicts 0.97 on average, against a tier-weight average of 0.76. The two wrong shown numbers (both at sf-r019, 300 and 200) score 0.75 and 0.71, below every correct shown number (minimum 0.995). The gold overconfidence gap is 0.065 (mean predicted 0.974, observed accuracy 0.909). The model is exported as the stored confidence. The displayed number is still chosen by votes, a quote, and a regex hit.

**Residual discovery.** The pre-fetch model does not beat the v0 prior on gold AUC and yield at 10 (AUC 0.628 against 0.644; yield at 10 is 0.50 for both). A residual model that starts from the v0 log-odds and adds the same features has gold log loss 0.604, against 0.610 for a recalibrated prior and 0.792 for the raw prior. Its AUC is 0.643 against the prior's 0.644. The features do not change the order. Keep the hand-set discovery order.

**Fit-prior bounds.** Hosts-yes `q(200)` is 0.209 for restaurant and for hotel. The ranking bounds are restaurant below 0.2 and hotel below 0.5. Restaurant misses by 0.009. The hand-set curve is about 0.02 for a restaurant and about 0.30 for a hotel. Keep the hand-set fit curve.

**Pre-screened top-up.** Google and the snapshot still run on every sampled venue. Grok and Claude run only when the saved page has event content. At the rates in this collection, 104 of 335 readable pages have event content and 29 of those have a teacher room (28%, against 10% of all readable pages). A 300-venue NYC, SF, and Honolulu sample would label about 48 pages, add about 13 venues with a room, and cost about $1.32 Grok, $0.25 Claude, and 22 Firecrawl credits. It needs 300 Google calls, 55 past the 245 left on the free cap. Reaching 60 training venues with a room (44 more) would mean about 994 sampled venues, about $4.36 Grok and $0.84 Claude, and 749 Google calls past the free cap. This top-up was not run. The xAI ledger was not charged.

