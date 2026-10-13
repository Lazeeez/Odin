set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [ ! -f "$ROOT/cluster/site.env" ]; then
  echo "MISSING cluster/site.env (copy cluster/site.env.example and fill it in)" >&2
  exit 1
fi
set -a
. "$ROOT/cluster/site.env"
set +a
export HF_HOME="$ODIN_SCRATCH/huggingface"
export UV_CACHE_DIR="$ODIN_SCRATCH/uv"
export PATH="$HOME/.local/bin:$PATH"

manifest_field() {
  python3 -c 'import json,sys; v=json.load(open(sys.argv[1]))
for k in sys.argv[2].split("."): v=v.get(k, "") if isinstance(v, dict) else ""
print(" ".join(v) if isinstance(v, list) else v)' "$1" "$2"
}

uv_overlay() {
  local args=()
  for package in $(manifest_field "$1" environment.with); do args+=(--with "$package"); done
  for index in $(manifest_field "$1" environment.index); do args+=(--index "$index" --index-strategy unsafe-best-match); done
  echo "${args[@]:-}"
}
