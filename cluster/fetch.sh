#!/bin/bash
. "$(dirname "$0")/common.sh"
MANIFEST="$(realpath "$1")"
cd "$ROOT"
uv run --frozen --extra dense $(uv_overlay "$MANIFEST") odin run --manifest "$MANIFEST" --fetch-only
