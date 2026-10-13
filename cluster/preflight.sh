#!/bin/bash
. "$(dirname "$0")/common.sh"
status=0
check() { if eval "$2" >/dev/null 2>&1; then echo "ok       $1"; else echo "MISSING  $1"; status=1; fi; }
for name in SLURM_ACCOUNT SLURM_PARTITION GPU_TYPE ODIN_RESULTS ODIN_SCRATCH; do
  check "$name is set in site.env" "[ -n \"\${$name:-}\" ]"
done
check "sbatch is available" "command -v sbatch"
check "account $SLURM_ACCOUNT is usable" "sacctmgr -n show assoc user=$USER account=$SLURM_ACCOUNT | grep -q ."
check "partition $SLURM_PARTITION exists" "sinfo -h -p $SLURM_PARTITION | grep -q ."
check "partition has gpu:$GPU_TYPE" "sinfo -h -p $SLURM_PARTITION -o %G | grep -q $GPU_TYPE"
check "results directory is writable" "mkdir -p $ODIN_RESULTS && touch $ODIN_RESULTS/.write-test"
check "scratch directory is writable" "mkdir -p $ODIN_SCRATCH && touch $ODIN_SCRATCH/.write-test"
check "git is available" "command -v git"
check "working tree is clean" "[ -z \"\$(git -C $ROOT status --porcelain --untracked-files=no)\" ]"
exit $status
