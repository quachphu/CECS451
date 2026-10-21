# AI usage and benchmarks

Date of the numbers below: 2026-10-21. Seed 451. Gold venues and every Los Angeles domain stayed out of training.

The logistic regressions were fit and scored. The app loads the candidate confidence model (`src/data/confidence-model.json`) and stores its probability on each displayed room. Discovery order and the fit curve stay hand-set: `src/data/discovery-prior.json` and `src/data/fit-priors.json` are still `placeholder-0`. A room with no stored score still uses its tier weight.

## 1. What each system does

| System | Role | In the app today |
| --- | --- | --- |
| Grok `grok-4.7` | Reads a saved page three times at temperature 0.7 and proposes room sizes. Same extraction the app runs. | Yes. This is the reader. |
| Claude `claude-sonnet-5-5` | Teacher. Labels each readable venue from the saved pages only. Prompt `teacher_v1`. Never sees Grok's output. | No. Offline labels. |
| Claude `claude-opus-5-5` | Second teacher. Same prompt, Batch API, used only to measure agreement with Sonnet. | No. |
| Candidate logistic regression | Probability that a number on the page is within 10% of a teacher room size. | Yes, as the stored capacity confidence. The displayed number is still chosen by votes, a quote, and a regex hit. |
| Event-content logistic regression | Probability that a readable site has a private-dining page, event wording, or an external event link. Features are the Google fields and the name only. | No. Coefficients are in `eval/results/discovery_event_model.json`. |
| Hosts-events logistic regression | Earlier model. Probability the teacher marked the venue as hosting private events. | No. An earlier fit is in `eval/results/discovery_model.json`. |
| Fit prior | Shrunk rate q(bucket, headcount): chance a venue of that type can hold the group. Not a logistic regression. | No. The hosts-yes table is in `eval/results/fit_prior_hosts.json`. |
| Hand-set tier weights | Belief in a printed capacity: verified 0.9, likely 0.6, unverified 0.3. | Yes. This is the capacity confidence the app uses. |
| Hand-set discovery order | Orders venues before any page is read. | Yes. |
| Hand-set fit curve | Restaurant midpoint 40, hotel midpoint 150. | Yes. `q(restaurant, 200)` is 0.02. `q(hotel, 200)` is 0.303. |

## 2. How to read a metric

Training chose the logistic penalty by out-of-fold log loss. A lower log loss is better. The 0.5 cutoff used for precision, recall, F1, and accuracy was not the selection rule.

| Metric | Meaning |
| --- | --- |
| Log loss | Penalty for a confident wrong probability. Lower is better. This is the number used to pick the model. |
| Brier score | Mean squared error of the probability. Lower is better. |
| AUC | Chance the model ranks a true positive above a true negative. 0.5 is no better than chance. 1 is perfect. |
| ECE | Expected calibration error. How far the predicted probability is from the observed frequency. Lower is better. |
| Accuracy | Share of rows whose probability is on the correct side of 0.5. High when almost every row is the same class. |
| Precision | Of the rows the model calls positive at 0.5, the share that are positive. |
| Recall | Of the true positives, the share the model calls positive at 0.5. |
| F1 | Harmonic mean of precision and recall. |
| Yield@K | Share of the top K venues, ordered by the score, that are positive. |
| Selection | Share of venues whose chosen number is within 10% of a teacher room size. |

A correct room figure is within 10% of a teacher seated or standing maximum. Gold is the held-out venue sample. LA is a city the models never train on. Out of fold means each training row was scored by a model that did not train on its website domain.

## 3. Data the models were fit on

655 venues were indexed. 335 pages could be read.

| Outcome | Count |
| --- | ---: |
| Readable | 335 |
| Robots blocked | 186 |
| Bot blocked | 58 |
| Empty after render | 51 |
| HTTP error | 23 |
| Parked or closed | 2 |

Of the 335 readable pages, 104 have event content (a private-dining page, event wording, or an external event link). 32 have at least one teacher room figure. 29 of those 32 also have event content.

Teacher labels on the 335 readable venues: hosts private events yes 99, no 34, unknown 202. Status labeled 322, unclear 13. Sonnet returned 123 positive seated or standing figures. Opus returned 113.

| Table | Train | Test | Train positives |
| --- | ---: | ---: | ---: |
| Candidate numbers | 530 rows | 571 rows | 58 numbers, from 15 venues |
| Event-content discovery | 147 venues | 188 venues | 46 venues |
| Hosts-yes fit prior | 43 venues | held out with the same split | 16 venues published a room size |
| Original confidence rows | 34 rooms, all correct | 38 rooms | 0 incorrect training rooms |
| Original hosts-events discovery | 59 venues | 74 venues | 43 venues |

## 4. Spend

| Service | Spent | Cap | What it bought |
| --- | ---: | ---: | --- |
| xAI (Grok) | $10.34 | $25 on the ledger | 335 venues extracted ($9.25, 971 calls) plus a second read of the 24 venues that had rooms ($1.09). The second read changed 0 displayed numbers. |
| Anthropic | $5.65 | $15 | Sonnet labels, $1.79 for 335 venues. Opus agreement run, $3.86 for the same 335 venues. 670 calls in total. |
| Firecrawl | 49 credits | 900 | 153 calls. Renders after a block or an empty page. 186 robots-blocked sites were not sent. |
| Google Places Text Search | 655 calls | 900 | One call per indexed venue. 245 calls remain on the free cap. |

The Opus estimate before the call was $3.36 expected and $9.50 worst case, against $13.21 remaining. The actual charge was $3.86.

## 5. Teacher labels

On 2026-10-21, Thien Phu Quach reviewed the teacher labels for all labeled venues and confirmed them as correct. The review was not recorded row by row. The statement is `eval/review/ATTESTATION.md`.

The quality gate passed on that attestation. Gold venues use the teacher labels with `label_source = teacher_human_confirmed`. Per-item human accuracy and Cohen's kappa are not reported.

Label quality is the agreement of the two teachers on all 335 readable venues, same prompt `teacher_v1`.

| Agreement | Value |
| --- | ---: |
| Venues compared | 335 |
| `hosts_private_events` the same | 0.854 |
| Labeled versus unclear the same | 0.979 |
| Sonnet figures within 10% of an Opus figure | 0.878 (108 of 123) |
| Opus figures within 10% of a Sonnet figure | 0.965 (109 of 113) |

## 6. Grok, the page reader

Grok is not a logistic regression. It proposes room sizes. Three reads, temperature 0.7. Only a number that appears in the page text is kept.

| Check | Result |
| --- | ---: |
| Readable venues sent | 335 |
| Venues that returned at least one room | 24 |
| Rooms in the first extract | 89 |
| Reads that disagreed on the number | 0 |
| Second extract, venues | 24 |
| Second extract, rooms | 82 |
| Rooms whose number changed | 0 |
| Scored modal rows that matched a teacher figure | Train 31 of 31. Test 41 of 41. |

Room-level precision, recall, and F1 against gold were not produced. `eval/results/extraction_eval.json` has null precision, recall, and F1 for every method, and the summary table shows 0 predicted figures. That report did not have gold room rows to score against.

The original confidence table, one row per Grok room that survived grounding, has 34 training rows and every one of them is correct. The logistic regression for that table was not fit. The rule requires at least 15 rows of the smaller class. The smaller class has 0 rows. The app keeps the tier weights and does not show "% likely to fit".

Tier-weight benchmark on the gold rooms that do exist (27 rooms in the original table):

| Baseline | Log loss | Brier | AUC | Accuracy |
| --- | ---: | ---: | ---: | ---: |
| B0 tier weight | 0.306 | 0.091 | 0.940 | 0.889 |
| B1 evidence lookup | 0.253 | 0.067 | 0.760 | 0.926 |
| B2 constant "always correct" | 2.558 | 0.074 | 0.500 | 0.926 |

B2 looks accurate because most gold rooms are correct, and its log loss on the few mistakes is 2.558. Log loss is the comparison that matters.

## 7. Candidate logistic regression

Question: is this number on the page within 10% of a teacher room size?

Fit on 530 training numbers (58 positive, 15 venues). Penalty C = 1, chosen by out-of-fold log loss. No class weights. The largest coefficients: one standard deviation more `llm_votes` multiplies the odds by 14.63. A capacity verb nearby multiplies the odds by 6.91. A private-dining page multiplies the odds by 5.77. A regex hit multiplies the odds by 2.52. A junk-looking number multiplies the odds by 0.44.

### Probability metrics

| Split | n | Positives | Log loss | Brier | AUC | ECE (width) | Accuracy |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Out of fold | 530 | 58 | 0.157 | 0.047 | 0.953 | 0.028 | 0.936 |
| Gold | 426 | 40 | 0.122 | 0.034 | 0.954 | 0.026 | 0.951 |
| LA gold | 102 | 28 | 0.279 | 0.085 | 0.931 | 0.085 | 0.873 |
| LA teacher-labeled | 145 | 10 | 0.028 | 0.004 | 1.000 | 0.025 | 0.993 |

Gold log-loss 95% interval: 0.048 to 0.232. Gold AUC 95% interval: 0.872 to 0.996.

### Precision, recall, and F1 at a 0.5 cutoff

| Split | Precision | Recall | F1 |
| --- | ---: | ---: | ---: |
| Out of fold | 0.786 | 0.569 | 0.660 |
| Gold | 0.771 | 0.675 | 0.720 |
| LA gold | 0.800 | 0.714 | 0.755 |
| LA teacher-labeled | 0.909 | 1.000 | 0.952 |

Gold accuracy of 0.951 should be read next to the base rate. 386 of the 426 gold numbers are not room sizes. Calling every number negative would already score 0.906.

### Did it pick the right number?

Share of venues whose chosen number is a correct room size.

| Split | Venues with a correct number | Model | Largest regex | Current pipeline | Votes + quote |
| --- | ---: | ---: | ---: | ---: | ---: |
| Train, out of fold | 15 | 0.933 | 0.533 | 0.600 | 0.933 |
| Gold | 10 | 0.800 | 0.500 | 0.400 | 0.900 |
| LA gold | 3 | 0.667 | 1.000 | 0.333 | 1.000 |
| LA teacher-labeled | 3 | 1.000 | 0.667 | 1.000 | 1.000 |

On the gold venues that have a correct number, the votes-plus-quote rule picks it more often than the logistic regression (0.900 against 0.800).

### Against the tier weight, on numbers the pipeline would show

| Split | Shown numbers | Correct | Model log loss | Tier-weight log loss | Model mean probability | Tier-weight mean |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Out of fold | 27 | 27 | 0.004 | 0.431 | 0.996 | 0.722 |
| Gold | 22 | 20 | 0.121 | 0.278 | 0.974 | 0.764 |
| LA gold | 17 | 17 | 0.001 | 0.105 | 0.999 | 0.900 |
| LA teacher-labeled | 10 | 10 | 0.001 | 0.765 | 0.999 | 0.540 |

The gold comparison is 22 numbers, 20 of them correct. The model is more confident than 0.9, which wins log loss on a nearly one-class sample. It was not loaded. The app keeps the tier weights.

## 8. Event-content logistic regression

Question: will reading this site yield event content? Positive means a private-dining page, event wording, or an external event link. Those signals are the label. They are not features. Features are Google price, rating, review count, category bucket, and name words. Penalty C = 0.01.

### Probability metrics

| Split | n | Positives | Model log loss | v0 log loss | Model AUC | v0 AUC | Model accuracy | v0 accuracy |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Out of fold | 147 | 46 | 0.598 | 0.734 | 0.653 | 0.731 | 0.680 | — |
| Gold | 130 | 43 | 0.612 | 0.792 | 0.628 | 0.644 | 0.692 | 0.538 |
| LA gold | 39 | 14 | 0.657 | 0.741 | 0.601 | 0.654 | 0.641 | 0.590 |
| LA teacher-labeled | 58 | 15 | 0.532 | 0.649 | 0.722 | 0.850 | 0.759 | 0.672 |

Gold ECE (equal width) is 0.042 for the model and 0.222 for the hand-set prior. The model is better calibrated. It ranks worse than the prior on every split above.

### Precision, recall, and F1 at a 0.5 cutoff

| Split | Precision | Recall | F1 |
| --- | ---: | ---: | ---: |
| Out of fold | 0.400 | 0.043 | 0.078 |
| Gold | 1.000 | 0.070 | 0.130 |
| LA gold | 0.000 | 0.000 | 0.000 |
| LA teacher-labeled | 1.000 | 0.067 | 0.125 |

Precision of 1.000 on gold means the few venues it calls positive are positive. Recall of 0.070 means it finds about 3 of the 43 gold venues that have event content. On LA gold it calls none of them positive.

### Yield

Share of the top K that have event content.

| Split | Yield@10 model | Yield@10 v0 | Yield@25 model | Yield@25 v0 |
| --- | ---: | ---: | ---: | ---: |
| Out of fold | 0.20 | 0.80 | 0.44 | 0.56 |
| Gold | 0.50 | 0.50 | 0.52 | 0.48 |
| LA gold | 0.40 | 0.40 | 0.44 | 0.44 |
| LA teacher-labeled | 0.40 | 0.70 | 0.44 | 0.44 |

### Residual model

A second fit starts from the hand-set prior's log-odds and lets the same features correct it.

| Gold, 130 venues | Log loss | AUC |
| --- | ---: | ---: |
| Raw hand-set prior | 0.792 | 0.644 |
| Prior only, recalibrated | 0.610 | — |
| Prior plus the pre-fetch features | 0.604 | 0.643 |

The features move gold log loss by 0.006 and leave AUC at 0.643 against the prior's 0.644. The hand-set discovery order stays.

## 9. Earlier hosts-events logistic regression

This is a different question from section 8. The label is the teacher's `hosts_private_events`, and venues the teacher marked unknown are left out. It was fit. It was not loaded, because shipping it moved the ranking tests.

| Split | n | Pre-fetch log loss | Pre-fetch AUC | Pre-fetch accuracy | v0 log loss | v0 AUC | v0 accuracy |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Out of fold | 59 | 0.499 | 0.726 | 0.780 | 0.552 | 0.703 | 0.729 |
| Gold | 51 | 0.529 | 0.777 | 0.667 | 0.571 | 0.763 | 0.765 |
| LA gold | 15 | 0.496 | 0.864 | 0.667 | 0.442 | 0.920 | 0.933 |
| LA teacher-labeled | 23 | 0.484 | 0.651 | 0.696 | 0.368 | 0.868 | 0.913 |

Yield on all test venues for the pre-fetch model: yield@10 is 1.000 against 0.900 for the hand-set prior. Yield@25 is 0.960 for both. On Los Angeles the hand-set prior has the higher AUC.

A post-fetch variant exists in the same result file. It adds one feature, an external event link. It is not used before scraping, and its page features would leak an event-content label, so the later model in section 8 dropped it.

## 10. Fit prior

q(bucket, headcount) is the chance a venue of that type can hold the group, including venues that publish no number.

The shipped curve is the hand-set one. Ranking requires `q(restaurant, 200)` under 0.2 and `q(hotel, 200)` under 0.5. The hand-set values are 0.020 and 0.303.

The hosts-yes table counts every train venue the teacher marked `hosts = yes`: 43 venues, 16 with a published room. A bucket with fewer than 25 such venues uses the global curve. Every bucket is under 25.

| Bucket | n | q(30) | q(50) | q(200) |
| --- | ---: | ---: | ---: | ---: |
| Fine dining | 0 | 0.35 | 0.30 | 0.21 |
| Casual restaurant | 10 | 0.35 | 0.30 | 0.21 |
| Steakhouse / grill | 6 | 0.35 | 0.30 | 0.21 |
| Bar / lounge | 16 | 0.35 | 0.30 | 0.21 |
| Hotel | 3 | 0.35 | 0.30 | 0.21 |
| Event space | 4 | 0.35 | 0.30 | 0.21 |
| Fast casual / cafe | 4 | 0.35 | 0.30 | 0.21 |
| All (global) | 43 | 0.35 | 0.30 | 0.21 |

`q(200)` is 0.209 for restaurant and for hotel. Restaurant misses the bound by 0.009. The hand-set curve stays.

An earlier table, conditional on publishing a room size, used 17 venues and had global `q(200) = 0.59`, casual restaurant 0.44, and hotel 0.56. That table fails both ranking bounds. It is in `eval/results/fit_prior.json` and is not loaded.

## 11. What would have to change before a model is loaded

| Model | Why it stayed out |
| --- | --- |
| Original room confidence | No incorrect training example. |
| Candidate confidence | On gold venues that have a correct number, selection is 0.800 against 0.900 for the votes-plus-quote rule. The 58 positives come from 15 venues. |
| Event-content discovery | Gold AUC 0.628 against 0.644 for the hand-set order. Yield@10 is 0.50 for both. Recall at 0.5 is 0.070. |
| Hosts-events discovery | Stronger than the prior on the mixed gold AUC, weaker on Los Angeles, and loading it failed the ranking tests. |
| Hosts-yes fit prior | `q(restaurant, 200) = 0.209`, which is above the required 0.2. |

A later top-up was priced and not run. Google and the snapshot would still run on every sampled venue. Grok and Claude would run only when the saved page has event content.

| Plan | Sampled venues | New venues with a room | Grok | Claude | Google calls past the free cap |
| --- | ---: | ---: | ---: | ---: | ---: |
| 300 venues, NYC / SF / Honolulu, pre-screened | 300 | about 13 | $1.32 | $0.25 | 55 |
| Reach 60 training venues with a room, pre-screened | 994 | 44 | $4.36 | $0.84 | 749 |
| Same target, no pre-screen | 901 | 44 | $12.72 | $2.46 | 656 |

There are 16 training venues with a teacher room today. The target of 60 needs 44 more.

## 12. Where the numbers are

| File | What it holds |
| --- | --- |
| `eval/results/candidate_model.json` | Candidate logistic regression. |
| `eval/results/discovery_event_model.json` | Event-content model and the residual model. |
| `eval/results/discovery_model.json` | Earlier hosts-events model. |
| `eval/results/confidence_model.json` | Original room model. Decision: not fit. Tier-weight benchmarks. |
| `eval/results/fit_prior_hosts.json` | Hosts-yes fit prior and the ranking bounds. |
| `eval/results/fit_prior.json` | Earlier fit prior, conditional on a published room. |
| `eval/results/teacher_quality.json` | Attestation gate and teacher-teacher agreement. |
| `eval/results/proposal_rescore.json` | Second Grok read of the 24 venues with rooms. |
| `eval/results/summary.md` | Pipeline summary, including the older hosts-events tables. |
| `eval/results/topup_prescreen.json` | Cost of a later top-up. |
| `eval/DATA_CARD.md` | Data card. |
