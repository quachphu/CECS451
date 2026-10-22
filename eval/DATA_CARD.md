# Data card: Private Dining Finder training data

Status: **real snapshots and human labels are collected.** Thien Phu Quach labeled the venues used for training and testing. The candidate confidence model was exported to `src/data/confidence-model.json` on 2026-10-21. Discovery order and the fit curve stay hand-set (`placeholder-0`). A displayed room stores the model's probability for its number. A room with no stored score still uses its tier weight.

## Intended use

Training and evaluating three small logistic models for the app:

1. **Capacity confidence:** P(an extracted room capacity is within 10% of the human label).
2. **Discovery prior:** P(a venue hosts private events), from data available before any page is read.
3. **Fit prior:** q(bucket, headcount), P(a venue's largest published room holds a group of that size).

Not intended for: describing individual venues to the public, any commercial use of the Google or Yelp data, or claims about venues outside the four sampled areas.

## Sources and licenses

| Source | What is used | License and handling |
| --- | --- | --- |
| Foursquare OS Places | Venue name, address, coordinates, website, category | Apache 2.0. Venue IDs and names are committed in `venues.csv`. |
| Google Places API (New), Text Search | Place ID, types, price level, rating, review count | Maps Platform terms. Only place IDs are kept long-term; `google_features.csv` is gitignored and must be deleted 30 days after collection (date: _to fill in_). |
| Venue websites | Page text of the homepage and private-dining pages; event PDFs only if approved at STOP 1 | Fetched once under RFC 9309 robots.txt, at most 1 request/s per host, identified as `private-dining-finder/0.2 (CSULB CECS 451 research; contact: quachphuwork@gmail.com)`. Snapshots are private and never committed. |
| Yelp Open Dataset (optional) | Weak "hosts events" labels | Educational use only; used only if approved at STOP 4. |

## Sampling

560 venues, stratified by city (NYC 145, SF 145, Honolulu 100, LA 170) and category bucket, with a 15% reserve per stratum to replace venues whose site cannot be read. Venues without a website of their own, with an invalid URL, or sharing a domain with an earlier venue are dropped before sampling. Seed 451.

## Labeling

- **Human labels:** Thien Phu Quach labeled the venues used for training and testing. Those are the labels the models are scored against. The statement is `eval/review/ATTESTATION.md`. The review was not recorded row by row. Per-item human accuracy and Cohen's kappa are not reported.
- **Reader being graded:** Grok (`XAI_MODEL`), three reads at temperature 0.7, the same extraction the app runs. It reads pages. It does not label the training data.

## Splits

Test = every gold venue and every LA venue (LA is a city the models never see in training). Train = every other venue the human labeled. A website domain is never on both sides. The split is asserted in `08_build_tables.ts` and again in every training script. The funnel rows named "teacher unclear" and "teacher labeled" are pipeline names for the human labels: unclear, and labeled.

## Data funnel

<!-- funnel:begin -->
| Step | NYC | SF | Honolulu | LA | All |
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
<!-- funnel:end -->

## Known gaps

- **PDFs and images.** Room sizes published only in a PDF or an image are missed unless PDF parsing is approved. Those pages are flagged `info_maybe_elsewhere`.
- **Third-party event pages.** Capacities on Tripleseat, SevenRooms and similar platforms are not read; only the presence of such a link is a feature.
- **Chains.** Sites that describe several locations are labeled "unclear" and left out of training.
- **Published sizes only.** The shipped fit curve is the hand-set one. A hosts-yes denominator (every train venue the human labeled `hosts = yes`, including venues with no published room) still gives `q(restaurant, 200) = 0.21`, which misses the ranking floor of 0.2, so that table stays in `eval/results/fit_prior_hosts.json`.
- **Candidate rows, 2026-10-21.** Saved pages produced 530 train candidate numbers (58 positives from 15 venues) and 571 test rows. Gold venues and LA domains stayed out of training. The candidate model is loaded as capacity confidence. The pre-fetch event-content model and the hosts-yes fit prior were not exported. A later top-up is a separate decision; this pass spent nothing.
- **Four areas.** Midtown Manhattan, SF Financial District/SoMa, Waikiki/Downtown Honolulu and three LA areas; other cities may differ.
- **English pages.** Non-English sites are flagged at snapshot time.
