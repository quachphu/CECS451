# AI core: engineering notes

Design decisions, open questions and verification for the AI core (extraction, grounding, confidence, ranking, discovery prior, robots.txt, corroboration and evaluation). The bracketed IDs, such as [P3], are cited in code comments and listed under References at the end.

## Design decisions

### Extraction

1. **Reservation filter.** A capacity candidate is dropped when reservation phrasing ("table for 2") appears in the match or the 30 characters before it. The check doesn't cover the full ±150-character context: almost every restaurant homepage has a booking widget, and a context-wide check would discard real room capacities printed near it.
2. **Room hints.** A hint is the nearest preceding capitalised `…Room / Hall / …` phrase within the same sentence. It is trimmed to the words after the last determiner, so an unpunctuated heading ("Private Events The Garden Room") doesn't bleed in. A room named after the number ("seats 120 in the Barbaresco Room") is not captured.
3. **Disagreement.** "Regex and LLM disagree" means the same room was read two ways: matched by room name, or the venue has a single room. An LLM room with no regex counterpart is `ai_extracted`.
4. **Several hinted regex candidates.** One `likely` room is created per distinct room name, so ranking can pick the smallest room that fits. Unhinted candidates contribute the smallest value of 6 or more, never the largest.
5. **Which page a figure comes from.**
   - Agreement and disagreement only count figures from the private-dining page, or figures the page attributes to the same room.
   - A regex-only figure from the homepage is `unverified`.
6. **LLM `minCapacity`.** Kept only when it is a positive integer no larger than the displayed maximum. In a `verified` room, the displayed maximum is the regex value.

### Schema and storage

7. **Optional TypeScript fields.** New `ScrapedSignals` and row fields are optional in TypeScript, although the scraper and migration 0011 always provide them. This keeps hand-built fixtures valid. Every reader falls back, for example `capacity_confidence ?? TRUST_WEIGHT[tier]`.
8. **Feature log.** `confidence_features` (jsonb) is part of migration 0011. Each logged vector records its `modelVersion`.
9. **Backfill in 0011.** Existing category-estimate rooms are flagged `is_estimate`, so existing databases match a fresh seed. These are rooms named `'Capacity unconfirmed'` or `'Private events available (capacity unpublished)'`, plus the two curated `(estimated…)` seed rooms. Trust tiers are unchanged.

### Ranking

10. **Estimate rooms.** Their number is ignored (`pFit = q`), and they receive a neutral capacity fit of 0.5 inside `U`.
11. **Undersized rooms.** These are non-estimate rooms smaller than the group, believed below 0.85, with `pFit ≥ 0.2`. They are kept, with the reason "may be too small for N; worth a call".
12. **Result cards.** Cards show three reasons: commute, room fit, and "About N% likely to fit". An estimate room reads "Capacity unpublished" instead of a guessed number.

### Safeguards

13. **Planner corroboration.** When a confirmation is held as `pending`, the whole confirmation waits, including any minimum spend in the same report. Belief uses the same `capacityBelief()` as ranking, so seeded `verified` rooms are protected too.
14. **Unreachable sites.**
    - An unreachable robots.txt (network error or timeout) means complete disallow (RFC 9309 §2.3.1.4), so the site isn't rendered either. It is labelled separately from an explicit `Disallow`.
    - A robots.txt that answers 4xx still allows rendering.
15. **robots.txt fetched in parallel with the homepage.** This saves up to 3 s per new host. For a disallowed site, one homepage request is still sent, and its body is discarded unread.
16. **Budgets under concurrency.** Render and LLM budgets are claimed synchronously in worker order. Candidates start in prior order, so the budget goes to the highest-prior candidates.

### Photos

17. **Photo names.** Google photo names are short-lived and may not be cached; only the place ID is stable.
    - The `/api/place-photo` proxy accepts a stored name.
    - When that name has expired, it fetches a fresh one through Place Details and reuses it for 30 minutes.
    - `npm run photos:backfill` adds photos for venues that have none. It accepts only a same-name place within 300 m.

### Evaluation

18. **NDCG gains.** Exponential, (2^rel − 1)/log₂(i + 1) [P8]. scikit-learn's `ndcg_score` uses linear gains, so the cross-check feeds it pre-transformed gains.
19. **The `combined` system.** It predicts "hosts private events" as: a private-dining page was found, and either the LLM didn't read it or the LLM agrees. The LLM can veto a false keyword hit.

## Open questions

1. **First-search latency when every page already has a static figure.** The verification read adds time where the earlier design skipped the LLM. The table below is simulated with fake timers (scrape 1 s, render 6 s, LLM 7 s, 45 candidates):

   | Scenario | Earlier design | Pipelined | Renders | LLM calls |
   | --- | --- | --- | --- | --- |
   | Private-dining page, no static figure | 49 s | **21 s** | 45 → 10 | 8 → 12 |
   | No private-dining page, no figure | 42 s | **14 s** | 45 → 10 | 0 → 0 |
   | Private-dining page with a static figure | **6 s** | **15 s** | 0 → 0 | 0 → 12 |

   Options for the third row:
   - raise `LLM_CONCURRENCY` to `MAX_LLM_BUDGET` (about 9 s);
   - cap verification reads separately (for example, 4);
   - skip verification once a run passes a time budget.
2. **Placeholder priors reorder some results.** With the hand-set base rates, a `likely` room in a generous category can outrank a `verified` restaurant room. For example, a hotel event space (`likely`, 120) scores 96% and Dos Caminos (`verified`, 50) scores 94%. Fitting `fit-priors.json` on labels is the first evaluation task.
3. **Seed rooms have no stored confidence.** They fall back to tier weights. Storing a confidence would need a feature vector for hand-researched rooms.
4. **`capacityNumbers` semantics.** It now holds the filtered candidates: no values below 6, and no reservations.

## Verification

| Check | Result |
| --- | --- |
| Unit and integration tests (`npm test`) | 226 passing; the original 28 ranking tests pass unchanged |
| Type check, lint, production build | Clean |
| Migrations | `supabase db reset` applies 0001–0011 on Postgres 17; the seed loads 14 venues with exactly 2 estimate rooms |
| Reference scenarios (`npm run test:scenarios`) | New York 4 results, San Francisco 4, Waikiki 2 |
| Garden Room regression | Previously stored as 180 guests, `verified`. Now Garden Room, 40, `likely`, confidence 0.617, with its evidence quote and URL. With an agreeing grounded LLM read, it becomes `verified`. |
| Google Places (live) | 73 candidates around Times Square, all with types and photos. The discovery prior ranks event hotels highest and fast food lowest. |
| Photo recovery (live) | An expired photo name returns 400; Place Details returns a fresh name, and Google serves the image |
| Photo backfill (live) | 10 of 11 photo-less venues matched; the one without a match has no Google photos |
| Browser walkthrough (Playwright, production build) | Workspace, search, live discovery, venue, shortlist, compare, summary, event page, Realtime chat, dietary roster errors, held confirmations, bad team code, unknown address |

### Pending live validation

- How often real xAI quotes pass grounding, and whether the schema accepts `evidenceQuote` / `minSpendEvidence`
- Firecrawl renders on real JavaScript-only sites
- ECE, NDCG@5 and kappa on real labels. The shipped coefficients are placeholders (`placeholder-0`).

## Known issues

- A capacity range can read in reverse ("Fits 200–30").
- Map markers, and the shortlist, compare and summary pages, choose a "best room" with their own logic and ignore `is_estimate`.
- The event link doubles as the workspace join code, and the anon key can read every workspace code (`companies` select policy `using (true)`).
- Leaflet throws `_leaflet_pos` when the page navigates away from the map mid-animation.
- A few form actions (save/delete address, shortlist add/remove, select venue) still throw on rare server-side failures, which shows the generic error page.

## References

- **P1** Xu et al., *Large Language Models for Generative Information Extraction: A Survey*, Frontiers of CS 2024. https://arxiv.org/abs/2312.17617
- **P2** Ji et al., *Survey of Hallucination in Natural Language Generation*, ACM Computing Surveys 2023. https://arxiv.org/abs/2202.03629
- **P3** Gao et al., *Enabling Large Language Models to Generate Text with Citations* (ALCE), EMNLP 2023. https://aclanthology.org/2023.emnlp-main.398
- **P4** Guo et al., *On Calibration of Modern Neural Networks*, ICML 2017. https://arxiv.org/abs/1706.04599
- **P5** Naeini, Cooper & Hauskrecht, *Obtaining Well Calibrated Probabilities Using Bayesian Binning*, AAAI 2015. https://ojs.aaai.org/index.php/AAAI/article/view/9602
- **P6** Platt, *Probabilistic Outputs for SVMs* (1999); Niculescu-Mizil & Caruana, *Predicting Good Probabilities with Supervised Learning*, ICML 2005
- **P7** Russell & Norvig, *Artificial Intelligence: A Modern Approach*, 4th ed., ch. 16. https://aima.cs.berkeley.edu/
- **P8** Järvelin & Kekäläinen, *Cumulated Gain-Based Evaluation of IR Techniques*, ACM TOIS 2002. https://doi.org/10.1145/582415.582418
- **P9** Cohen, *A Coefficient of Agreement for Nominal Scales*, 1960. https://doi.org/10.1177/001316446002000104
- **S1** RFC 9309, *Robots Exclusion Protocol*. https://www.rfc-editor.org/rfc/rfc9309
- **D1–D13** Vendor documentation: Firecrawl v2 Scrape, xAI Structured Outputs, Google Places Nearby Search (New) and Maps Platform terms, Supabase local development and type generation, PostgreSQL `ALTER TABLE`, Vitest `vi`, scikit-learn (calibration, `LogisticRegression`, `ndcg_score`, `cohen_kappa_score`), OSM Overpass, Next.js Server Actions
- **C1–C5** Reference implementations: princeton-nlp/ALCE, gpleiss/temperature_scaling, google/robotstxt, sindresorhus/p-limit, CPython `urllib.robotparser`
