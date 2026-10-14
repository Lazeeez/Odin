#!/bin/bash
. "$SLURM_SUBMIT_DIR/cluster/common.sh"
stamp() { echo "[$(date +%T)] $*"; }
SHARED_CACHE="$ODIN_SCRATCH/cache"
OUT="$ODIN_RESULTS/script-$SLURM_JOB_ID"
WORK="${TMPDIR:-/tmp}/odin-$USER-$SLURM_JOB_ID"
nvidia-smi --query-gpu=name,memory.total --format=csv,noheader
stamp "copying the repository and the cache to node-local disk at $WORK"
mkdir -p "$WORK/.cache" "$OUT"
rsync -a --exclude .cache --exclude .venv "$ROOT/" "$WORK/"
rsync -a --exclude "analysis.sqlite*" "$SHARED_CACHE/" "$WORK/.cache/"
finish() {
  stamp "copying results and the cache back"
  rsync -a "$WORK/results/" "$OUT/results/"
  rsync -a "$WORK/models/" "$OUT/models/"
  rsync -a --exclude "analysis.sqlite*" "$WORK/.cache/" "$SHARED_CACHE/"
  rm -rf "$WORK"
  stamp "results in $OUT"
}
trap finish EXIT
cd "$WORK"
export PATH="$ROOT/.venv/bin:$PATH"
stamp "running: $ODIN_COMMAND"
bash -c "$ODIN_COMMAND"
stamp "finished"
