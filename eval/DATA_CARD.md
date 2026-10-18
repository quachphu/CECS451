# Data card: Private Dining Finder training data

Status: **pipeline built and dry-run tested; real data not collected yet.** The funnel below is filled in by `scripts/data/08_build_tables.ts` when the pipeline runs on real data.

## Intended use

Training and evaluating three small logistic models for the app:

1. **Capacity confidence:** P(an extracted room capacity is within 10% of the truth).
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

- **Student:** Grok (`XAI_MODEL`), three reads at temperature 0.7, the same extraction the app runs.
- **Teacher:** Claude (`TEACHER_MODEL`, default `claude-sonnet-5-5`), prompt `ml/prompts/teacher_v1.md`. It sees only the saved pages and event links, never the student's output (asserted in `ml/teacher.py` and its tests). Every quote it returns must appear in the page text.
- **People:** four reviewers (Christopher, Albert, Han, Phu) check 120 labeled and 10 "unclear" teacher venues; 24 venues are reviewed twice for agreement (Cohen's kappa). Disagreements are settled by hand in `review/conflicts.csv`.
- **Gate:** the teacher's labels are used for training only if room precision and venue accuracy on the gold set are both at least 0.90.

## Splits

Test = every gold venue and every LA venue (LA is a city the models never see in training). Train = every other venue the teacher labeled. A website domain is never on both sides. The split is asserted in `08_build_tables.ts` and again in every training script.

## Data funnel

<!-- funnel:begin -->
_Not run on real data yet._
<!-- funnel:end -->

## Known gaps

- **PDFs and images.** Room sizes published only in a PDF or an image are missed unless PDF parsing is approved; the teacher flags them with `info_maybe_elsewhere`.
- **Third-party event pages.** Capacities on Tripleseat, SevenRooms and similar platforms are not read; only the presence of such a link is a feature.
- **Chains.** Sites that describe several locations are labeled "unclear" and left out of training.
- **Published sizes only.** The fit prior is conditional on a venue publishing a room size.
- **Four areas.** Midtown Manhattan, SF Financial District/SoMa, Waikiki/Downtown Honolulu and three LA areas; other cities may differ.
- **English pages.** Non-English sites are flagged at snapshot time.
