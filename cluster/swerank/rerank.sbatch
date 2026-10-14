#!/bin/bash
set -euo pipefail
SW="$HOME/scratch/swerank"
export HF_HOME="$HOME/scratch/odin-cache/huggingface" HF_TOKEN_PATH="$HOME/.cache/huggingface/token"
export PYTHONUTF8=1 PYTHONPATH="$SW/repo/src" NCCL_P2P_DISABLE=1 VLLM_WORKER_MULTIPROC_METHOD=spawn
PY="$SW/env/bin/python"
OUT="$SW/out/rerank-$RTAG"
RETRIEVED="$SW/out/$RETRIEVER_TAG/results.json"
DATA_TYPE="SweRankEmbed-Large_$RTAG"
mkdir -p "$OUT"
stamp() { echo "[$(date +%T)] $*"; }
nvidia-smi -L
MODEL_PATH="$("$PY" -c "from huggingface_hub import snapshot_download; print(snapshot_download('$RERANKER', revision='$REVISION'))")"
stamp "reranking $RETRIEVED with $RERANKER at $REVISION"
cd "$SW/repo"
"$PY" src/rerank.py --model "$MODEL_PATH" --dataset_dir "$SW/$DATA" --dataset_name swe-bench-lite \
  --retriever_output_dir "$RETRIEVED" --data_type "$DATA_TYPE" --output_dir "$OUT" --eval_dir "$OUT" \
  --top_k 100 --window_size 10 --step_size 5
stamp "scoring with the authors' evaluator"
"$PY" src/refactored_eval_localization.py --model SweRankEmbed-Large --output_dir "$OUT" \
  --reranker_output_dir "$OUT/$DATA_TYPE" --dataset_dir "$SW/$DATA" --dataset swe-bench-lite | tail -6
stamp "done: $OUT"
