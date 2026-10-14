#!/bin/bash
set -euo pipefail
SW="$HOME/scratch/swerank"
ODIN="$HOME/scratch/Odin"
export HF_HOME="$HOME/scratch/odin-cache/huggingface" HF_TOKEN_PATH="$HOME/.cache/huggingface/token"
export PYTHONUTF8=1 PYTHONPATH="$SW/repo/src"
PY="$SW/env/bin/python"
OUT="$SW/out/$TAG"
mkdir -p "$OUT"
stamp() { echo "[$(date +%T)] $*"; }
nvidia-smi -L
cd "$SW/repo"
stamp "retrieving with $MODEL ($MODE) over $DATA"
if [ "$MODE" = "authors" ]; then
  "$PY" src/eval_beir_sbert_canonical.py --dataset_dir "$SW/$DATA" --dataset swe-bench-lite \
    --model "$MODEL" --batch_size "${BATCH:-32}" --output_file "$OUT/output.json" \
    --results_file "$OUT/results.json" --eval_mode default --split test --add_prefix --level function
else
  "$PY" "$ODIN/scripts/swerank_cached_retrieval.py" --dataset_dir "$SW/$DATA" --model "$MODEL" \
    --revision "$REVISION" --batch_size "${BATCH:-32}" --cache "$SW/cache/$(basename "$MODEL")" \
    --results_file "$OUT/results.json"
fi
stamp "scoring with the authors' evaluator"
"$PY" src/refactored_eval_localization.py --model "$(basename "$MODEL")" --output_dir "$OUT" \
  --dataset_dir "$SW/$DATA" --output_file "$OUT/results.json" --dataset swe-bench-lite | tail -6
stamp "done: $OUT"
