#!/bin/bash
. "$(dirname "$0")/common.sh"
COMMAND="$1"
mkdir -p "$ODIN_SCRATCH/logs" "$ODIN_RESULTS"
sbatch --account="$SLURM_ACCOUNT" --partition="${PARTITION:-$SLURM_PARTITION}" ${SLURM_QOS:+--qos="$SLURM_QOS"} \
  ${EXCLUDE:+--exclude="$EXCLUDE"} \
  --gres="gpu:${GPU:-$GPU_TYPE}:${GPUS:-1}" --cpus-per-task="${CPUS:-8}" --mem="${MEM:-32G}" \
  --time="${WALL_HOURS:-2}:00:00" --job-name="odin-script" \
  --output="$ODIN_SCRATCH/logs/script-%j.log" \
  --export=ALL,ODIN_COMMAND="$COMMAND" \
  "$ROOT/cluster/script.sbatch"
echo "log: $ODIN_SCRATCH/logs/script-<jobid>.log"
echo "results: $ODIN_RESULTS/script-<jobid>/"
