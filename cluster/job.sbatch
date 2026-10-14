#!/bin/bash
. "$SLURM_SUBMIT_DIR/cluster/common.sh" 2>/dev/null || . "$(dirname "$MANIFEST")/../common.sh"
if [ "${ODIN_OFFLINE:-0}" = "1" ]; then
  export HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1
fi
NAME="$(manifest_field "$MANIFEST" name)"
ENV="$(job_env "$MANIFEST")"
SHARED_CACHE="$ODIN_SCRATCH/cache"
stamp() { echo "[$(date +%T)] $*"; }

nvidia-smi --query-gpu=name,memory.total --format=csv,noheader
if [ "${ODIN_LOCAL_DISK:-1}" = "1" ] && [ -n "${SLURM_JOB_ID:-}" ]; then
  WORK="${TMPDIR:-/tmp}/odin-$USER-$SLURM_JOB_ID"
  stamp "copying the repository and the cache to node-local disk at $WORK"
  mkdir -p "$WORK/.cache"
  rsync -a --exclude .cache --exclude .venv "$ROOT/" "$WORK/"
  rsync -a "$SHARED_CACHE/" "$WORK/.cache/"
  trap 'stamp "copying the cache back"; rsync -a "$WORK/.cache/" "$SHARED_CACHE/"; rm -rf "$WORK"' EXIT
  stamp "copied: $(du -sh "$WORK/.cache" | cut -f1) of cache"
  cd "$WORK"
else
  cd "$ROOT"
fi
stamp "ranking"
"$ENV/bin/odin" run --manifest "$MANIFEST" --out "$RUN_DIR"
stamp "ranked"
mkdir -p "$ODIN_RESULTS/$NAME"
cp -r "$RUN_DIR/manifest.json" "$RUN_DIR/run.json" "$RUN_DIR/SHA256SUMS" "$RUN_DIR/rankings" "$ODIN_RESULTS/$NAME/"
stamp "copied to $ODIN_RESULTS/$NAME"
