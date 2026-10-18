# Training pipeline: notes

Working log for the offline data and training pipeline (branch `feat/training-pipeline`). It records API differences, prices, caps and decisions as they are confirmed.

## STOP 0 findings (2026-10-18)

### Code prerequisites
- Present: `src/lib/discovery/grounding.ts`, the `evidenceQuote` schema in `llm-extract.ts`, and `privateDiningText` in `scraper.ts`.
- `npm test` passed: 228 tests in 25 files.
- **Missing:** self-consistency. Production makes a single Grok read at `temperature: 0` (`llm-extract.ts`), so k = 3 reads at 0.7 does not exist yet.
- `grok-4.5` is hard-coded in `llm-extract.ts`, `nl-query.ts` and `dietary-summary.ts`. It is to move to the `XAI_MODEL` env var.

### Models

| Role | Model | Price per 1M tokens (in / out) | Verified |
| --- | --- | --- | --- |
| Student | `grok-4.7` (via `XAI_MODEL`) | $2 / $6; no batch discount reported | No: `api.x.ai` unreachable from the first session; from third-party pricing pages |
| Teacher (default) | `claude-sonnet-5-5` (via `TEACHER_MODEL`) | $2 / $10; Batches API 50% off | Yes: `GET /v1/models/claude-sonnet-5-5` returned 200 |
| Teacher (option) | `claude-opus-5-5` | $4 / $20; Batches API 50% off | Model list only |

Teacher API notes:
- Sonnet 5.5 rejects non-default `temperature`.
- Forced `tool_choice` returns a 400; use `output_config.format` for strict JSON.
- Thinking is adaptive by default; set `output_config.effort` to bound output tokens.
- `fallbacks` is rejected on the Batches API.

### Budget forecasts (to be replaced by pilot measurements)
- **xAI, cap $25:** about $16 for 500 venues × 3 reads × (~3.5k in + ~0.6k out). Hidden reasoning tokens could push it over the cap; measure in the pilot.
- **Anthropic, cap $15:** about $9–13 with Sonnet on the Batches API, plus about $1 for the 20-venue non-batch pilot. Opus would be roughly 2× and would not fit.
- **Firecrawl, cap 900 credits:** unknown until the pilot. PDF parsing is reported as +1 credit per PDF page, so the 150-credit PDF sub-cap matters.

### Google Places free cap (unverified)
- The Text Search field mask in Step 2 includes `rating` and `userRatingCount`, which bills at the **Enterprise** SKU.
- Secondary sources report free monthly caps of 1,000 for Enterprise, 5,000 for Pro and 10,000 for Essentials, with a separate cap per SKU.
- Google's own pricing page was unreachable; confirm it and record the figure here.
- Planned usage is about 650–700 calls: 560 venues, the reserves and retries.
- Runtime impact: if the discovery prior uses `rating` and review count, the app's Nearby Search must request those fields, which moves every discovery call to Enterprise.

### Environment
- The first session's network policy blocked `api.x.ai`, `api.firecrawl.dev`, `huggingface.co`, the venue websites and the production Supabase host.
- `places.googleapis.com` and `api.anthropic.com` were reachable.
- A policy change takes effect only in a new session.
- Keys must come from the environment's settings (variables or network secrets), not a committed file.

### Open decisions
1. Self-consistency: A (add k = 3 parallel reads at 0.7 to production) or B (keep a single read and drop the feature).
2. Keep `rating` / `userRatingCount` features despite the Enterprise SKU?
3. "Go" for Step 1.
