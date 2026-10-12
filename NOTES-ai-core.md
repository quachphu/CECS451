# AI core v1: engineering notes

Branch `feat/ai-core-v1`, one commit per step. This file records decisions,
deviations from the task spec, open questions, measured timings, and what
could not be verified in the environment this was built in.

## Baseline and final state

| | Baseline (`95e4a8a` + setup files) | Final |
| --- | --- | --- |
| `npm test` | 100 / 100 | 200 / 200 (21 files) |
| `npx tsc --noEmit` | clean | clean |
| `npm run lint` | clean, 0 warnings | clean, 0 warnings |
| `npm run build` | — | succeeds (11 routes) |

Existing test assertions changed: only the three trust-tier assertions listed
in the Step 2 commit (regex-only becomes `likely`), and one test I added
myself in Step 1 and split in Step 7. All 28 tests in `ranking.test.ts` pass
unchanged.

## Environment constraints (read this first)

The cloud sandbox's network policy blocked most external hosts:

- **Blocked:** Nominatim, Overpass, Photon, OpenRouteService, `api.x.ai`, `api.firecrawl.dev`, `*.supabase.co`, real venue sites, and the documentation sites (`docs.x.ai`, `docs.firecrawl.dev`, `rfc-editor.org`, `vitest.dev`, `developers.google.com`).
- **Reachable:** npm, PyPI, GitHub raw content and Docker Hub.

Consequences:

- **Local Supabase** (`npx supabase start`, Docker) worked. Migrations, the seed, `test:scenarios`, the pipeline defect rerun and the browser click-through all ran against it.
- **Geocoding** for the seed, scenarios and click-through used a test-only fetch shim. It answered Nominatim lookups with the real coordinates already stored in the project's Supabase. The shim lived in a scratch directory and is not committed.
- **Not exercised live:** the xAI, Firecrawl, Google Places, Overpass and ORS behaviour. These paths are covered by unit tests with stubbed `fetch`, and by `scripts/verify-*.ts`, which must be run where the network allows.

## References: what was actually read

| ID | Status |
| --- | --- |
| D1 Firecrawl v2 scrape | Read via the docs' OpenAPI spec on GitHub (`firecrawl/firecrawl-docs`). Confirmed: `formats`, `onlyMainContent` (default **true**), `timeout`, `maxAge`, `storeInCache`; markdown billing is 1 credit per page. |
| D2 xAI structured outputs | **Not reachable.** The schema uses only the keywords the existing extraction schema already used in production (`type` incl. `["string","null"]` unions, `enum`, `required`, `additionalProperties: false`, `description`), plus a plain `string` property. Re-check against D2 before relying on `evidenceQuote` in production. |
| D3 Places Nearby Search | Read via `googleapis/googleapis` protos: `types` and `primary_type` exist on `Place`; field mask name `places.types`. **SKU/billing impact of adding `places.types` not verified** (docs unreachable). I believe the mask already triggers a higher SKU through `websiteUri`/`priceLevel`, but confirm. |
| D3b Maps terms | Not reachable. Design follows the prompt's summary: `types` is used at runtime only and never persisted; Places-derived eval files are gitignored. |
| D4–D6 Supabase / Postgres | Applied via the CLI (`db reset` replays 0001–0011 on Postgres 17). |
| D7 Vitest `vi` | Read (`vitest-dev/vitest` docs source). `useFakeTimers` fakes `Date` by default and does not fake `nextTick`/`queueMicrotask`; `advanceTimersByTimeAsync`/`runAllTimersAsync` used accordingly. |
| D8/D9/D11/D12 scikit-learn | Used directly (scikit-learn 1.9.1): `LogisticRegression`, `calibration_curve`, `ndcg_score`, `cohen_kappa_score`. |
| S1 RFC 9309 | rfc-editor.org not reachable. Implemented from Google's reference parser **C3** (read in full where relevant): longest match; allow wins ties; a specific-agent group overrides `*`; product-token extraction. Redirect limit (5), the 4xx/5xx rules and the 500 KiB limit follow the prompt and the RFC as I know it. |
| C1 ALCE | `eval.py` read. ALCE scores citation support with an NLI model; we use exact normalised substring match (stricter, deterministic, no model). |
| C2 temperature scaling | `_ECELoss` read; ECE binning mirrored (left-open bins; first bin also includes 0). |
| C4 p-limit | Read; `createLimiter` follows the same active-count + FIFO-queue pattern. |
| C5 urllib.robotparser | Read; first-match, deliberately not copied. |
| P1–P9 papers | Not fetched (blocked). The formulas used are those given in the prompt (ECE, NDCG with 2^rel−1 gains, kappa, MEU), cross-checked numerically against scikit-learn. |

## Decisions and deviations

1. **Reservation filter scope (2a).** The spec says to drop a candidate when its ±150-char *context* matches reservation phrasing. I check the match plus the 30 chars before it. Almost every restaurant homepage carries a "Book a table for 2" widget, and a context-wide check would drop real room capacities that merely sit near it.
2. **Room hints (2a).** The hint is the nearest preceding capitalised `…Room/Hall/…` phrase *within the same sentence*. It is trimmed to what follows the last determiner, because headings without punctuation ("Private Events The Garden Room") otherwise bleed in. A hint that *follows* the number ("seats 120 in the Barbaresco Room") is not captured, as specified ("preceding").
3. **Defining "disagreement" (2f).** "Regex and LLM disagree" is interpreted as *the same room read two ways*: matched by room name, or the single-room case. An LLM room with no counterpart is `ai_extracted`. This keeps the existing disagreement tests' meaning.
4. **Several hinted regex candidates (2f).** The spec says "use the candidate whose roomHint is non-null". With several distinct hinted rooms I create one `likely` room per room name rather than picking one, so ranking can pick the smallest that fits. Unhinted: the smallest candidate ≥ 6. Never the max.
5. **LLM `minCapacity`.** Kept only when ≤ the displayed figure. The displayed figure in a `verified` room is the regex value.
6. **New `ScrapedSignals` / Row fields are optional in TypeScript.** The scraper always sets them, and migration 0011 always provides them. They are optional so hand-built signals and the existing test fixtures (which build full literals) stay valid without edits. Every reader falls back (for example `capacity_confidence ?? TRUST_WEIGHT[tier]`).
7. **`confidence_features` jsonb** was folded into migration 0011 (the spec's preferred option), along with `modelVersion` in each logged vector.
8. **Extra backfills in 0011.** Besides `'Capacity unconfirmed'`, the migration also flags `'Private events available (capacity unpublished)'` (the other name the pipeline gives a category estimate) and the two curated `(estimated…)` seed rooms, so existing databases match a fresh seed. Tiers are untouched.
9. **Estimate rooms in ranking.** Their number is ignored (pFit = q) and they get a neutral 0.5 capacity fit inside U.
10. **Undersized rooms in ranking.** These are non-estimate rooms smaller than the group, believed below 0.85, with pFit ≥ 0.2. They get a new honest second reason ("may be too small for N; worth a call") instead of the existing "Fits N in X" string, which would be false there.
11. **`venue-card.tsx` (copy only).** It shows the first **three** reasons instead of two, because the new "% likely to fit" line is the third and the checklist expects it on the card. An estimate room reads "Capacity unpublished" instead of "Fits <guess>", since an estimate venue can now appear for a group larger than its guessed number.
12. **Planner corroboration scope (Step 8).** When the capacity part of a confirmation goes to `pending`, the *whole* confirmation waits, including any minimum spend in the same report. It's one row with one status; applying half of it seemed worse. Belief uses the same `capacityBelief()` as ranking, so seeded `verified` rooms (no stored confidence, tier weight 0.9) are protected too.
13. **robots.txt and a fully unreachable site (Step 7).** Previously a site that refused every plain fetch fell through to Firecrawl. Now, if robots.txt itself is unreachable (network error/timeout), RFC 9309 §2.3.1.4 means complete disallow, so nothing is rendered either. If robots.txt answers 4xx but the homepage refuses a fetch, rendering still happens (the original intent).
14. **robots.txt in parallel with the homepage (Step 7).** As specified, both are requested at once. For a disallowed homepage, one homepage request is therefore still sent; its body is discarded unread. If strict pre-checking is preferred, make it sequential (costs up to 3 s per new host).
15. **Budgets under concurrency.** Render and LLM budgets are claimed synchronously in worker order. Candidates *start* in prior order, so the budget goes to the highest-prior candidates, within the 8-wide concurrency window.
16. **NDCG gains.** Exponential (2^rel − 1)/log2(i+1) per [P8]. scikit-learn's `ndcg_score` uses linear gains, so the cross-check feeds it pre-transformed gains.
17. **Eval system definitions.** `combined` predicts "hosts private events" as private-dining page found AND (no LLM read OR the LLM agrees). The LLM can veto a false keyword hit; this is noted in the script.
18. **Formatting.** New files are formatted with Prettier at width 120 with `es5` trailing commas, which matches most of the existing code. Pre-existing files were not reformatted, apart from `trust.ts`, which was mostly rewritten.

## Open questions

1. **First-search latency when every page already has a static figure.** Step 2's second (verification) read costs time exactly where the old design skipped the LLM. Simulated with fake timers (scrape 1 s, render 6 s, LLM 7 s, 45 candidates):

   | Scenario | Old inline | New pipelined | Renders | LLM calls |
   | --- | --- | --- | --- | --- |
   | Private-dining page, no static figure (spec's scenario; the perf guard test) | 49 s | **21 s** | 45 → 10 | 8 → 12 |
   | No private-dining page, no figure | 42 s | **14 s** | 45 → 10 | 0 → 0 |
   | Private-dining page **with** a static figure | **6 s** | **15 s** | 0 → 0 | 0 → 12 |

   The third row breaks "no slower than today". Options: raise `LLM_CONCURRENCY` to `MAX_LLM_BUDGET` (about 9 s in that row), cap verification reads separately (say 4), or skip verification when a run is already past a time budget. I kept the spec's concurrency of 8 pending a decision.
2. **Placeholder priors visibly reorder results.** In local scenario runs, a `likely` room in a generous category bucket outranks a `verified` restaurant room:
   - NYC: Renaissance "Hotel event space" (banquet bucket, `likely` 120) at 96% vs Dos Caminos (`verified` 50) at 94%.
   - SF: Wayfare "American tavern" (bar bucket) above Kokkari (`verified` 30, exact fit).

   This is the specified formula working as designed. `pFit = p + (1−p)·q` with a high placeholder q lifts `likely` rooms. Fitting `fit-priors.json` on labels should be the eval's first job. Until then, consider lower placeholder q for the banquet, hotel and bar buckets at small headcounts.
3. **Seed rooms have no stored confidence.** Seeded rooms fall back to tier weights. Should `seed.ts` compute and store confidence, which would need a feature vector for hand-researched rooms?
4. **`capacityNumbers` semantics changed.** It is now the filtered candidates (no values < 6, no reservations). Nothing in the app reads it besides the pipeline and `verify-enrichment.ts`, but external scripts would see different numbers.

## Measured and verified

- **Migration 0011, local:** `supabase db reset` applies 0001–0011 cleanly (Postgres 17). `scripts/seed.ts` seeds 14 venues; exactly the two estimate rooms (Tropics, Chart House) have `is_estimate = true`.
- **Migration 0011, project database:** applied to the `PrivateDining` Supabase project via the Supabase connector. All 5 room columns and the `status` column are present; 26 rooms are backfilled as estimates (24 discovered + 2 curated); data intact at 38 venues and 49 rooms.
- **`npm run test:scenarios` against local Supabase:** all three scenarios return results (NYC 4, SF 4, Waikiki 2) in **2.9 s** wall-clock. These were cache hits (freshly seeded venues are within the 30-day TTL).
- **Cold discovery wall-clock: not measured.** Overpass and venue sites are blocked here. Measure with `node --conditions=react-server --import tsx scripts/loadtest-density.ts` where the network allows.
- **Garden Room defect rerun.** This ran the real `runDiscoveryPipeline` into local Postgres, with Overpass and the site served by a shim. The room is stored as `Garden Room`, `max_capacity` 40, `likely`, `is_estimate` false, `capacity_confidence` 0.617, `evidence_quote` "…The Garden Room holds 40 guests for private dinners.", `evidence_url` …/private-events, plus a feature log. Before the change it was 180 / min 2 / `verified`. With an agreeing grounded LLM read it becomes `verified` (unit-tested; xAI unreachable here).
- **Performance guard:** see the table above, enforced by `pipeline-timing.test.ts`.
- **Browser click-through.** This used Playwright with the pre-installed Chromium against `next start` and local Supabase:
  - created a workspace, searched NYC for 50 people with a 20-minute walk: 4 cards, each showing "About N% likely to fit your group";
  - opened the venue page and added it to the shortlist;
  - confirmed 500 for a 40-seat `verified` room: toast "Saved for review", row `status = pending`, capacity unchanged at 40;
  - the shortlist and compare pages render.

  There were no page errors. The only failed requests were OpenStreetMap map tiles (blocked network) and aborted Next.js prefetches during navigation.
- **Eval harness, exercised end to end on toy inputs** (synthetic site, local seeded venues, made-up labels and judgments; all deleted, none committed). The snapshot step honours robots.txt. Extraction shows v0 at 180 vs 40 for the new systems, and a 0.5 grounding rejection rate on an invented room. The trainer refuses to fit on too few rows; kappa and NDCG compute. These are **not** results; real numbers need labelled data.

## Not verified (needs network or keys)

- Real xAI responses: schema acceptance of `evidenceQuote`/`minSpendEvidence` (see D2 above) and how often real quotes pass grounding.
- Real Firecrawl renders, and the Google Places `types` field and its billing.
- Real robots.txt files in the wild (the parser is tested on RFC cases).
- ECE / NDCG / kappa on real labels: no labels exist yet. The shipped coefficients are placeholders (`placeholder-0`).

## Out-of-scope bugs noticed (not fixed)

- `venue-card.tsx` shows a range as "Fits 200–30" (max–min reversed). This is pre-existing and visible on Carmine's.
- Map markers (`search-results.tsx` → map) still show an estimate room's guessed capacity (maps are out of scope).
- `shortlist`, `compare` and `summary` pages choose a "best room" with their own logic and ignore `is_estimate`, so they can still show an estimate's number.
- Auth: the event link is also the workspace join code, and the anon key can read every workspace code (`companies` select policy `using (true)`).
- The 25 MB Server Action body limit is left over from the removed attachment feature.
- `scripts/test-scenarios.ts` uses walk mode for NYC, while the landing preview uses drive for the same scenario.

## Reference list (IDs cited in code comments)

- **P1** Xu et al., *Large Language Models for Generative Information Extraction: A Survey*, Frontiers of CS 2024. https://arxiv.org/abs/2312.17617
- **P2** Ji et al., *Survey of Hallucination in Natural Language Generation*, ACM Computing Surveys 2023. https://arxiv.org/abs/2202.03629
- **P3** Gao et al., *Enabling Large Language Models to Generate Text with Citations* (ALCE), EMNLP 2023. https://aclanthology.org/2023.emnlp-main.398
- **P4** Guo et al., *On Calibration of Modern Neural Networks*, ICML 2017. https://arxiv.org/abs/1706.04599
- **P5** Naeini, Cooper & Hauskrecht, *Obtaining Well Calibrated Probabilities Using Bayesian Binning*, AAAI 2015. https://ojs.aaai.org/index.php/AAAI/article/view/9602
- **P6** Platt, *Probabilistic Outputs for SVMs* (1999); Niculescu-Mizil & Caruana, *Predicting Good Probabilities with Supervised Learning*, ICML 2005. https://www.cs.cornell.edu/~alexn/papers/calibration.icml05.crc.rev3.pdf
- **P7** Russell & Norvig, *Artificial Intelligence: A Modern Approach*, 4th ed., ch. 16. https://aima.cs.berkeley.edu/
- **P8** Järvelin & Kekäläinen, *Cumulated Gain-Based Evaluation of IR Techniques*, ACM TOIS 2002. https://doi.org/10.1145/582415.582418
- **P9** Cohen, *A Coefficient of Agreement for Nominal Scales*, 1960. https://doi.org/10.1177/001316446002000104
- **S1** RFC 9309, *Robots Exclusion Protocol*. https://www.rfc-editor.org/rfc/rfc9309
- **D1** Firecrawl v2 Scrape · **D2** xAI Structured Outputs · **D3** Google Places Nearby Search (New) · **D3b** Maps Platform service terms · **D4** Supabase local development · **D5** PostgreSQL `ALTER TABLE` · **D6** Supabase type generation · **D7** Vitest `vi` · **D8** scikit-learn calibration · **D9** `LogisticRegression` · **D10** OSM Overpass / Map Features · **D11** `ndcg_score` · **D12** `cohen_kappa_score` · **D13** Next.js Server Actions (URLs in the task prompt)
- **C1** princeton-nlp/ALCE · **C2** gpleiss/temperature_scaling · **C3** google/robotstxt · **C4** sindresorhus/p-limit · **C5** CPython `urllib.robotparser`
