#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
data_dir="${XDG_DATA_HOME:-$HOME/.local/share}/diffusion-studio"
python_env="$data_dir/python"

if ! command -v uv >/dev/null 2>&1; then
  echo "uv is required. Install uv, then rerun this script." >&2
  exit 1
fi

if [[ ! -x "$python_env/bin/python" ]]; then
  uv venv --python 3.12 "$python_env"
fi

uv pip install --python "$python_env/bin/python" -r "$script_dir/requirements.txt"
"$python_env/bin/python" "$script_dir/transcribe.py" --download-model
echo "Local transcription and Manim are ready: $python_env/bin/python"
