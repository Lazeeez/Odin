#!/bin/bash
. "$(dirname "$0")/common.sh"
command -v uv >/dev/null || curl -LsSf https://astral.sh/uv/install.sh | sh
mkdir -p "$ODIN_SCRATCH/cache" "$ODIN_RESULTS"
[ -e "$ROOT/.cache" ] || ln -s "$ODIN_SCRATCH/cache" "$ROOT/.cache"
cd "$ROOT"
uv sync --frozen --extra dense
uv run --no-sync python -c "import torch; print('torch', torch.__version__)"
