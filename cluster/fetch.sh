#!/bin/bash
. "$(dirname "$0")/common.sh"
MANIFEST="$(realpath "$1")"
ENV="$(job_env "$MANIFEST")"
cd "$ROOT"
if [ "$ENV" != "$ROOT/.venv" ] && [ ! -x "$ENV/bin/odin" ]; then
  echo "building the job's environment in $ENV"
  uv venv --clear --python 3.11 "$ENV"
  indexes=()
  for index in $(manifest_field "$MANIFEST" environment.index); do
    indexes+=(--extra-index-url "$index" --index-strategy unsafe-best-match)
  done
  "$ENV/bin/python" "$ROOT/cluster/job_requirements.py" "$ROOT" "$MANIFEST" > "$ENV/requirements.txt"
  uv pip install --python "$ENV/bin/python" "${indexes[@]}" -r "$ENV/requirements.txt"
  uv pip install --python "$ENV/bin/python" --no-deps -e "$ROOT"
fi
"$ENV/bin/odin" run --manifest "$MANIFEST" --fetch-only
echo "fetch finished"
