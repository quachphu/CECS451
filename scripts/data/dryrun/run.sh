#!/usr/bin/env bash
# Dry run of the whole training pipeline (Steps 1-13) on a synthetic world, offline.
#
#   bash scripts/data/dryrun/run.sh [out-dir]
#
# Every network call goes to the in-process shim (sites, Google, Firecrawl,
# xAI) or the local mock Anthropic server; real keys are replaced by dummies,
# and the shim refuses any other host. Results land in <out-dir>/eval and
# <out-dir>/models; src/data is never touched. The parity fixture is written
# to <out-dir>/model-parity.json (pass PARITY_OUT to write it elsewhere).
set -euo pipefail
cd "$(dirname "$0")/../../.."
OUT="$(realpath -m "${1:-.dryrun}")"
PORT="${DRYRUN_PORT:-8765}"
rm -rf "$OUT"
mkdir -p "$OUT/models"

export TRAINING_EVAL_DIR="$OUT/eval" DRYRUN_WORLD="$OUT/world.json" MODEL_EXPORT_DIR="$OUT/models"
export GOOGLE_PLACES_API_KEY=dryrun XAI_API_KEY=dryrun FIRECRAWL_API_KEY=dryrun ANTHROPIC_API_KEY=dryrun HF_TOKEN=dryrun
export XAI_MODEL=grok-4.7 TEACHER_MODEL=claude-sonnet-5-5 TEACHER_BASE_URL="http://127.0.0.1:$PORT"
export FSQ_PARQUET="$OUT/fsq.parquet"
SHIM=(npx tsx --import ./scripts/data/dryrun/shim.ts)
step() { echo; echo "=== $* ==="; }

step "world"; npx tsx scripts/data/dryrun/world.ts "$OUT"
step "01 sample"; npx tsx scripts/data/01_sample_venues.ts
step "02 google"; "${SHIM[@]}" scripts/data/02_enrich_google.ts
step "03 pilot"; "${SHIM[@]}" scripts/data/03_snapshot.ts --pilot
step "03 full"; "${SHIM[@]}" scripts/data/03_snapshot.ts --full
step "03 replace"; "${SHIM[@]}" scripts/data/03_snapshot.ts --replace
step "02 google (replacements)"; "${SHIM[@]}" scripts/data/02_enrich_google.ts
step "04 student"; "${SHIM[@]}" scripts/data/04_extract_student.ts

python3 scripts/data/dryrun/mock_anthropic.py "$PORT" &
MOCK=$!
trap 'kill $MOCK 2>/dev/null || true' EXIT
sleep 1
step "05 teacher pilot"; python3 scripts/data/05_label_teacher.py --pilot
step "05 teacher batch"; python3 scripts/data/05_label_teacher.py --batch
step "05 teacher collect"; python3 scripts/data/05_label_teacher.py --collect

step "06 review sheets"; npx tsx scripts/data/06_build_review_sheets.ts
step "reviewers (simulated)"; npx tsx scripts/data/dryrun/simulate_reviewers.ts "$DRYRUN_WORLD"
step "07 ingest"
set +e; npx tsx scripts/data/07_ingest_review.ts; code=$?; set -e
if [ "$code" = 2 ]; then
  step "conflicts (resolved from the truth)"; npx tsx scripts/data/dryrun/simulate_reviewers.ts "$DRYRUN_WORLD" --resolve
  npx tsx scripts/data/07_ingest_review.ts
elif [ "$code" != 0 ]; then exit "$code"; fi
step "08 tables"; npx tsx scripts/data/08_build_tables.ts
step "09 extraction eval"; npx tsx scripts/data/09_eval_extraction.ts
step "train confidence"; python3 ml/train_confidence.py
step "train discovery"; python3 ml/train_discovery.py
step "fit prior"; python3 ml/build_fit_prior.py
step "parity fixture"; python3 ml/export_fixtures.py --source "synthetic dry run (scripts/data/dryrun)" --out "${PARITY_OUT:-$OUT/model-parity.json}"
step "summary"; python3 ml/evaluate.py
echo; echo "Dry run complete: $OUT/eval/results/summary.md"
