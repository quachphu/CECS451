# Private Dining Finder

Private Dining Finder helps event planners find a restaurant or venue with a private room that fits their group, within a set commute of the office. Each venue's capacity is read from its own website and checked against the source text. Every figure carries a trust label, and results are ranked by the probability that the venue can actually host the group.

CECS 451 (Artificial Intelligence) course project. Built with Next.js 16, Supabase and xAI Grok.

## Contents

1. [Project description](#1-project-description)
2. [Problem](#2-problem)
3. [Solution](#3-solution)
4. [Architecture and project structure](#4-architecture-and-project-structure)
5. [AI algorithms](#5-ai-algorithms)
6. [Getting started](#6-getting-started)
7. [Limitations](#7-limitations)

## 1. Project description

### Videos

- Demo video: to be added
- Architecture walkthrough: to be added

### Features

| Feature               | Description                                                                                                                                                                                          |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Search                | Filter by office address, headcount, maximum commute, walk or drive, and room style. A plain-English request ("40 people, 10-minute walk, seated") can fill in the form.                             |
| Venue discovery       | When an area has fewer than three recently checked venues, the app finds new candidates, reads their websites and extracts room capacities.                                                          |
| Ranking               | Venues are ranked by expected utility, which combines commute, room fit and the probability that the room really fits. Each result lists its reasons, including "About N% likely to fit your group". |
| Trust labels          | Every capacity and price figure is labelled `confirmed_by_planner`, `verified`, `likely`, `ai_extracted` or `unverified`.                                                                            |
| Shortlist and compare | Save candidates, compare rooms, prices and commute times side by side, and choose one.                                                                                                               |
| Event page            | A shared page where guests post allergies and dietary needs in real time. The app summarises them into a roster for the venue.                                                                       |
| Shared catalog        | A planner who confirms a figure with the venue updates it for later searches. Confirmations that contradict strong evidence are held for review.                                                     |

The application supports research and coordination only. It does not make bookings or payments.

### Screenshots

| New York (Times Square)                        | San Francisco (Salesforce Tower)                               | Waikiki (Hilton Hawaiian Village)          |
| ---------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------ |
| ![New York results](architecture/new_york.png) | ![San Francisco results](architecture/SanFrancisco_result.png) | ![Waikiki results](architecture/Hawai.png) |

## 2. Problem

Finding a private room for 30 to 200 people is mostly manual research.

- **No structured source exists.** No public API lists private rooms and their capacities. The information sits on each venue's events page, in PDFs, on JavaScript-rendered sites, or only with the venue's staff.
- **Capacity is stated inconsistently.** Sites write "seats 40", "up to 120 guests for receptions", or describe a room without giving any number.
- **Reliability is not visible.** A planner's notes mix confirmed figures, estimates and outdated listings, with no record of which is which.
- **Simple automation introduces errors.** A keyword scraper can take "our dining room seats 180" from a homepage and report it as a private room. A language model can produce a capacity that the page never states.

The main risk is booking a room that cannot hold the group.

## 3. Solution

The system attaches evidence to each capacity figure and ranks venues by how likely that figure is to be correct.

1. **Discovery.** Candidates come from Google Places and OpenStreetMap. A learned prior decides which candidates receive the limited budget of page renders and model calls.
2. **Two independent readers.** A pattern matcher and a language model each read the venue's private-dining page. The model must return the exact sentence that supports each capacity.
3. **Grounding.** A model answer is kept only if its quoted sentence appears on the page and contains the number. Agreement between the two readers makes a figure `verified`.
4. **Confidence.** Each room receives a probability that its capacity is correct, computed from the evidence features.
5. **Ranking.** Expected-utility ranking ensures an estimated capacity cannot outrank a published one simply because the estimate is closer to the headcount.
6. **Planner feedback.** Figures confirmed by phone are written back to the shared catalog, with a check against likely input errors.

Only the Supabase keys are required. Each paid service (Google Places, Firecrawl, xAI, OpenRouteService) has a free fallback, and results produced by a fallback are labelled as such.

## 4. Architecture and project structure

### System architecture

![System architecture](architecture/architecture.png)

The editable source is [`architecture/architecture.excalidraw`](architecture/architecture.excalidraw). It opens at [excalidraw.com](https://excalidraw.com) via Open.

Steps 1 to 10 describe one search; the lower panel shows what happens after it. Box colours indicate the component type: application, AI model, discovery step, external API, or database.

| Step | Description                                                                           | Source                                      |
| ---- | ------------------------------------------------------------------------------------- | ------------------------------------------- |
| 1    | Geocode the office address                                                            | `src/lib/geo/geocode.ts`                    |
| 2    | Cache check: at least three nearby venues checked in the last 30 days skips to step 8 | `src/lib/discovery/ensure-coverage.ts`      |
| 3    | Find candidates in Google Places and OpenStreetMap; merge duplicates within 75 m      | `src/lib/discovery/places.ts`               |
| 4    | Order candidates by the discovery prior                                               | `src/lib/discovery/discovery-prior.ts`      |
| 5    | Check robots.txt, fetch the site, render JavaScript-only pages with Firecrawl         | `scraper.ts`, `robots.ts`, `render.ts`      |
| 6    | Extract capacities with the regex reader and the LLM reader                           | `scraper.ts`, `llm-extract.ts`              |
| 7    | Grounding check, trust tier and confidence score; save to Postgres                    | `grounding.ts`, `trust.ts`, `confidence.ts` |
| 8    | Commute times from the OpenRouteService matrix, or a labelled estimate                | `src/lib/geo/commute.ts`                    |
| 9    | Expected-utility ranking                                                              | `src/lib/ranking.ts`                        |
| 10   | Result cards and map                                                                  | `src/components/venue-card.tsx`             |

### Technology stack

| Layer                 | Technology                                                                                                                    |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Framework             | Next.js 16 (App Router, Server Components, Server Actions), React 19, TypeScript                                              |
| UI                    | Tailwind CSS 4, shadcn/ui, Leaflet (2D map), MapLibre GL (3D map)                                                             |
| Database              | Supabase: Postgres 17, row-level security, Realtime                                                                           |
| Language model        | xAI Grok (`XAI_MODEL`, default `grok-4.7`) over HTTPS, JSON-schema structured output                                          |
| Venue data            | Google Places API (New), OpenStreetMap Overpass                                                                               |
| Page rendering        | Firecrawl v2, used only for JavaScript-rendered pages                                                                         |
| Routing and geocoding | OpenRouteService Matrix, Nominatim, Photon                                                                                    |
| Testing               | Vitest, Playwright                                                                                                            |
| Offline training      | Python, scikit-learn, DuckDB (Foursquare OS Places), Claude `claude-sonnet-5-5` as the labeling teacher (Message Batches API) |

### Project structure

```
CECS451/
├── architecture/              Architecture diagram (.excalidraw, .png) and screenshots
├── eval/                      Training data, review tool, data card, metrics and baselines
├── ml/                        Python: teacher labeling helpers, model training, evaluation
├── public/                    Static assets (curated venue photos)
├── scripts/
│   ├── seed.ts                Load the curated venues, then look up their photos
│   ├── backfill-photos.ts     Add Google photos to venues without one
│   ├── test-scenarios.ts      Run the three reference searches
│   ├── data/                  Training pipeline Steps 1-8 (sample, enrich, snapshot,
│   │                          student, teacher, review, tables) and the offline dry run
│   ├── eval-ranking.ts        NDCG@5 for each ranking method
│   ├── verify-*.ts            Checks against the live external services
│   └── loadtest-density.ts    Cold-discovery timing in a dense area
├── src/
│   ├── app/                   Routes: /, /start, /search, /venue/[id], /shortlist,
│   │   │                      /compare, /summary/[code], /event/[code]
│   │   ├── actions.ts         Server Actions (all writes)
│   │   └── api/               place-photo (photo proxy), geocode-suggest
│   ├── components/            Search form, venue card, map, event chat, dietary panel
│   ├── data/                  Curated venues and model coefficients (JSON)
│   └── lib/
│       ├── discovery/         Places, scraper, robots.txt, rendering, LLM extraction,
│       │                      grounding, trust, confidence, discovery prior, pipeline
│       ├── geo/               Geocoding, commute matrix, bounding boxes
│       ├── ranking.ts         Expected-utility ranking
│       ├── nl-query.ts        Plain-English search parsing
│       ├── dietary-summary.ts Dietary roster from the event chat
│       ├── corroboration.ts   Review rule for planner confirmations
│       └── supabase/          Database clients and types
├── supabase/migrations/       Database schema, 0001 to 0011
├── NOTES-ai-core.md           Design decisions, verification and references
└── NOTES-training.md          Training pipeline: procedure, budgets, decisions, status
```

## 5. AI algorithms

The system combines three language-model tasks with four small, interpretable models. The three learned models are trained offline (`ml/`, see [`NOTES-training.md`](NOTES-training.md)) and exported as JSON to `src/data/`. Until a model file holds a trained model, the app uses the v0 behaviour described under each model.

### 5.1 Components

| Component           | Method                 | Purpose                                               |
| ------------------- | ---------------------- | ----------------------------------------------------- |
| Query parsing       | LLM, structured output | Convert a plain-English request into search fields    |
| Capacity extraction | Regex and LLM          | Read room names and capacities from a venue's site    |
| Grounding           | Deterministic check    | Reject model answers the page does not support        |
| Capacity confidence | Logistic regression    | Probability that a stored capacity is correct         |
| Discovery prior     | Logistic regression    | Probability that a candidate hosts private events     |
| Ranking             | Expected utility       | Order venues by the expected value of contacting them |
| Dietary roster      | LLM, structured output | Summarise guests' messages into per-person needs      |

All language-model calls use xAI Grok (`XAI_MODEL`, default `grok-4.7`) with a strict JSON schema. Query parsing and the dietary roster run at temperature 0; capacity extraction makes three reads at temperature 0.7 (Section 5.2). Each call has an input limit, a timeout and a non-model fallback, so the application keeps working when the model is unavailable.

### 5.2 Capacity extraction

Each venue's capacity is read by two independent readers.

- **Regex reader.** It matches phrases such as "seats 40" or "up to 120 guests". For each match it records the surrounding sentence and the nearest room name. Values below 6 and reservation phrases ("table for 2") are discarded.
- **LLM reader.** It reads the private-dining page (up to 12,000 characters) three times in parallel at temperature 0.7 and returns each room with its capacity and an `evidenceQuote`: the exact sentence that states the capacity. A room's capacity is the most common answer across the reads; its **self-consistency** is the share of reads within 10% of that answer (Wang et al., 2022).

The private-dining page is read before the homepage, because homepage figures usually describe the main dining room rather than a private space.

### 5.3 Grounding

A model answer is accepted only when two conditions hold:

1. its `evidenceQuote` appears on the page, after case, whitespace and quotation marks are normalised; and
2. the quote contains the capacity, written in digits or in words.

Answers that fail either condition are discarded. The approach follows the citation checking in ALCE (Gao et al., 2023), but uses an exact match in place of a second model.

### 5.4 Trust tiers

| Evidence                                                                                            | Tier                   |
| --------------------------------------------------------------------------------------------------- | ---------------------- |
| Confirmed by a planner with the venue                                                               | `confirmed_by_planner` |
| Regex (private-dining page) and grounded LLM agree within 20%                                       | `verified`             |
| Both readers found the same room but disagree, or the regex reader alone on the private-dining page | `likely`               |
| Grounded LLM reading only                                                                           | `ai_extracted`         |
| Regex reading from the homepage only                                                                | `unverified`           |
| No figure found; category estimate shown as "Capacity unpublished"                                  | `is_estimate`          |

### 5.5 Capacity confidence

A room read by the LLM receives a confidence score, P(the capacity is within 10% of the truth), from a logistic model:

```
confidence = σ(b + Σ wᵢ xᵢ),    σ(z) = 1 / (1 + e^(−z))
```

The features `xᵢ`, computed by one function (`src/lib/discovery/features.ts`) for both training and the app, are:

- self-consistency across the three reads;
- whether the regex reader agrees (within 20%), disagrees, or found no figure;
- whether the evidence quote passed grounding;
- the number of distinct capacity figures on the page;
- whether a private-dining page was found.

The model is trained offline on about 500 venues: the LLM's rooms are labeled by a second model (Claude) that reads the same pages, and people check a gold sample of 130 venues (`NOTES-training.md`). C is chosen by grouped cross-validation on log loss, and calibration is reported as Expected Calibration Error (Guo et al., 2017). The score is computed once, when a venue is saved, and stored with the model version. Rooms read by regex only, estimates, and rooms showing a figure other than the LLM's keep their v0 tier weight (verified 0.9, likely 0.6, ai_extracted 0.45, unverified 0.3). Until a trained model is loaded, every room uses its tier weight and the app does not show "% likely to fit".

### 5.6 Discovery prior

Each search is limited to 10 Firecrawl renders and 12 LLM reads. Before this budget is spent, every candidate is scored with a second logistic model:

```
P(hosts private events) = σ(b + w · features)
```

The trained prior's features are the category bucket (from Google's place types), price level, rating, log review count (each with a missing flag) and keywords in the name. Candidates are processed in descending order of this probability. Until it is trained, a hand-set v0 prior over place type, price level, website and name keywords is used.

### 5.7 Expected-utility ranking

```
pFit  = p · 1[room fits] + (1 − p) · q     p = capacity confidence
pFit  = q                                  when the capacity is an estimate

U     = 0.5 · commute score + 0.35 · capacity fit + 0.15 · style match

score = pFit · U − (1 − pFit) · λ          λ = 0.25
```

`q` is the base rate at which a venue of the given category has a space for `h` guests. The trained fit prior is a table per category bucket and headcount, shrunk toward the overall rate (α = 5), made non-increasing in `h` and interpolated linearly; until it is trained, a hand-set logistic curve in `h` is used. `λ` is the cost of contacting a venue that turns out not to fit.

Venues with `pFit < 0.2` are excluded, as are rooms that are too small with confidence of 0.85 or more. Ties are broken by `pFit`, then commute time, then name. This follows the maximum expected utility principle (Russell and Norvig, ch. 16): an unconfirmed estimate contributes utility only in proportion to the belief that it is correct.

### 5.8 Safeguards

- **robots.txt (RFC 9309).**
  - The longest matching rule applies, and Allow wins a tie.
  - A 4xx response permits crawling.
  - A 5xx or unreachable robots.txt means the site is skipped and marked for a phone call.
- **Planner corroboration.** A confirmation is held for review instead of being applied when the room's confidence is at least 0.85 and the reported figure differs by more than 50%.
- **Separate queues.** Scraping and model calls run in separate queues, eight at a time, so a slow model call does not hold up scraping.

### 5.9 Evaluation

The training pipeline (`scripts/data/`, `ml/`, described in [`eval/README.md`](eval/README.md)) reports, on held-out gold venues and separately on LA (a city never trained on):

| Metric                                                           | Measures                                                                                                             |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Room precision, recall, F1 and invented-number rate              | Extraction quality: v0 regex maximum, regex candidates, one LLM read, and the shipped three-read grounded extraction |
| Log loss, Brier score, ROC AUC, ECE (equal-width and equal-mass) | Confidence model against the v0 tier weights, an evidence lookup table and a constant                                |
| AUC and yield@10/25                                              | Discovery prior against the v0 prior and random order                                                                |
| Cohen's kappa                                                    | Agreement between two reviewers                                                                                      |
| NDCG@5, gain 2^rel − 1                                           | Ranking quality against human judgments (`scripts/eval-ranking.ts`)                                                  |

Metric implementations are cross-checked against scikit-learn, and the TypeScript model scoring is checked against scikit-learn's `predict_proba` to 1e-6. `npm run data:dryrun` runs the whole pipeline offline on synthetic data.

## 6. Getting started

### Prerequisites

- Node.js 20 or later
- A Supabase project, or Docker to run Supabase locally
- Optional API keys: Google Places, xAI, Firecrawl, OpenRouteService

### Installation

```bash
git clone https://github.com/quachphu/CECS451.git
cd CECS451
npm install
cp .env.example .env.local
```

### Environment variables

| Variable                        | Required | Behaviour when unset                                                  |
| ------------------------------- | -------- | --------------------------------------------------------------------- |
| `NEXT_PUBLIC_SUPABASE_URL`      | Yes      |                                                                       |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Yes      |                                                                       |
| `SUPABASE_SERVICE_ROLE_KEY`     | Yes      |                                                                       |
| `GOOGLE_PLACES_API_KEY`         | No       | Discovery uses OpenStreetMap only; venues have no photos              |
| `XAI_API_KEY`                   | No       | No LLM reader, query parsing or dietary roster; figures stay `likely` |
| `FIRECRAWL_API_KEY`             | No       | JavaScript-rendered pages are marked for a phone call                 |
| `ORS_API_KEY`                   | No       | Commute times are straight-line estimates, labelled as such           |

`.env.local` is excluded from version control.

### Database

Apply the migrations in `supabase/migrations/` and load the curated venues:

```bash
npx supabase login
npx supabase link --project-ref <project-ref>
npx supabase db push
npm run seed
```

To use a local Supabase instance instead, run `npx supabase start`, copy the printed URL and keys into `.env.local`, then run `npm run seed`. `npx supabase db reset` reapplies all migrations.

### Running

```bash
npm run dev                          # development server at http://localhost:3000
npm run build && npm run start       # production build
```

### Reference scenarios

| Scenario                                              | Address                                   |
| ----------------------------------------------------- | ----------------------------------------- |
| 50 people, under 20 minutes                           | `Times Square, New York, NY`              |
| 30 people, under 15 minutes                           | `415 Mission St, San Francisco, CA 94105` |
| 200 people, reception style, under 15 minutes walking | `Hilton Hawaiian Village, Honolulu, HI`   |

### Commands

| Command                      | Description                                                  |
| ---------------------------- | ------------------------------------------------------------ |
| `npm test`                   | Unit and integration tests                                   |
| `npm run lint`               | ESLint                                                       |
| `npm run test:scenarios`     | Run the three reference searches                             |
| `npm run photos:backfill`    | Add Google photos to venues without one                      |
| `npm run eval:ranking`       | NDCG@5 for each ranking method                               |
| `npm run data:dryrun`        | Run the whole training pipeline offline on synthetic data    |
| `python3 -m pytest ml/tests` | Python tests (requires `pip install -r ml/requirements.txt`) |

The training pipeline's steps are listed in [`eval/README.md`](eval/README.md).

The scripts in `scripts/verify-*.ts` and `scripts/loadtest-density.ts` call the live external services and use API credits. Run them with `npx tsx scripts/<name>.ts`. Scripts that import server modules need `node --conditions=react-server --import tsx scripts/<name>.ts`.

### Troubleshooting

| Symptom                                                     | Resolution                                                                        |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `Failed to write rooms … is 0011_ai_core.sql applied?`      | Run `npx supabase db push` to apply the missing migration                         |
| Venue cards show "No photo found"                           | Set `GOOGLE_PLACES_API_KEY`, run `npm run photos:backfill` and restart the server |
| Port 3000 is in use                                         | `npm run dev -- -p 3001`                                                          |
| Plain-English search reports that the model did not respond | Check `XAI_API_KEY`; the standard search form works without it                    |

## 7. Limitations

Ranking uses the capacity printed on the venue's own site, the trust label on that figure, and the commute. The boundaries below are the ones the product is built to keep.

- **Evidence has to be on the page.** A capacity is kept when its supporting sentence appears in the saved text and contains the number. A paraphrase of that sentence is left for the planner to confirm. Every figure that reaches the ranking is one the venue published.
- **The first search in a new area does the reading.** With fewer than three venues checked in the last 30 days, the app fetches pages before it ranks. Searches after that use the cache. In simulation that first pass is about 15 seconds, and a cached search is about 6 seconds.
- **Some sites are left for a phone call.** When a site blocks automated reading, or the only capacity is in a PDF or an image, the venue is marked for the planner to confirm.
- **A team shares one workspace.** Access is a team code. That code opens the shared catalog and the event page for the people planning together.
- **Estimates on the map and the compare page.** The result card labels an unpublished capacity as an estimate. The map marker and the compare view still present that case less clearly, and a printed range can show its two ends swapped. Both views read the same saved capacity.

## References

- Gao et al., _Enabling Large Language Models to Generate Text with Citations_ (ALCE), EMNLP 2023
- Guo et al., _On Calibration of Modern Neural Networks_, ICML 2017
- Wang et al., _Self-Consistency Improves Chain of Thought Reasoning in Language Models_, 2022
- Niculescu-Mizil and Caruana, _Predicting Good Probabilities with Supervised Learning_, ICML 2005
- Russell and Norvig, _Artificial Intelligence: A Modern Approach_, 4th ed., ch. 16
- Järvelin and Kekäläinen, _Cumulated Gain-Based Evaluation of IR Techniques_, ACM TOIS 2002
- Cohen, _A Coefficient of Agreement for Nominal Scales_, 1960
- RFC 9309, _Robots Exclusion Protocol_

The full reference list and design notes are in [`NOTES-ai-core.md`](NOTES-ai-core.md).
