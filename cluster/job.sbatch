#!/bin/bash
. "$SLURM_SUBMIT_DIR/cluster/common.sh" 2>/dev/null || . "$(dirname "$MANIFEST")/../common.sh"
export HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1
NAME="$(manifest_field "$MANIFEST" name)"
cd "$ROOT"
nvidia-smi --query-gpu=name,memory.total --format=csv,noheader
uv run --frozen --offline --extra dense $(uv_overlay "$MANIFEST") odin run --manifest "$MANIFEST" --out "$RUN_DIR"
mkdir -p "$ODIN_RESULTS/$NAME"
cp -r "$RUN_DIR/manifest.json" "$RUN_DIR/run.json" "$RUN_DIR/SHA256SUMS" "$RUN_DIR/rankings" "$ODIN_RESULTS/$NAME/"
echo "copied to $ODIN_RESULTS/$NAME"
