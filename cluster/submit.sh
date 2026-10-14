#!/bin/bash
. "$(dirname "$0")/common.sh"
MANIFEST="$(realpath "$1")"
NAME="$(manifest_field "$MANIFEST" name)"
HOURS="${WALL_HOURS:-$(manifest_field "$MANIFEST" expected.wall_hours)}"
RUN_DIR="$ODIN_SCRATCH/runs/$NAME"
mkdir -p "$RUN_DIR" "$ODIN_RESULTS"
sbatch --account="$SLURM_ACCOUNT" --partition="$SLURM_PARTITION" ${SLURM_QOS:+--qos="$SLURM_QOS"} \
  --gres="gpu:$GPU_TYPE:${GPUS:-1}" --cpus-per-task="${CPUS:-8}" --mem="${MEM:-32G}" \
  --time="${HOURS:-2}:00:00" --job-name="odin-$NAME" \
  --output="$RUN_DIR/slurm-%j.log" \
  --export=ALL,MANIFEST="$MANIFEST",RUN_DIR="$RUN_DIR" \
  "$ROOT/cluster/job.sbatch"
echo "run directory: $RUN_DIR"
echo "copied on completion to: $ODIN_RESULTS/$NAME"
