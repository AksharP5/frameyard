#!/usr/bin/env bash
set -euo pipefail

: "${XDG_DATA_HOME:?}" "${DIFFUSION_CHROMIUM_BIN:?}" "${DIFFUSION_TEST_GSAP:?}" "${DIFFUSION_TEST_VITE_URL:?}"
output="$(dirname "$XDG_DATA_HOME")"
test -x "$XDG_DATA_HOME/diffusion-studio/python/bin/python"
test -x "$XDG_DATA_HOME/diffusion-studio/tools/node_modules/.bin/hyperframes"
test -x "$XDG_DATA_HOME/diffusion-studio/tools/node_modules/.bin/hyfrme"
test -x "$DIFFUSION_CHROMIUM_BIN"
test -f "$DIFFUSION_TEST_GSAP"

npm run dev --workspace=@diffusionstudio/web -- --host 127.0.0.1 --port 5173 --strictPort > "$output/vite.log" 2>&1 &
vite_pid=$!
trap 'kill "$vite_pid" 2>/dev/null || true' EXIT
for attempt in {1..60}; do
  if curl --fail --silent "$DIFFUSION_TEST_VITE_URL/@vite/client" > /dev/null; then break; fi
  kill -0 "$vite_pid"
  sleep 1
done
curl --fail --silent "$DIFFUSION_TEST_VITE_URL/@vite/client" > /dev/null
npm test 2>&1 | tee "$output/test.log"
# Missing optional runtimes must fail CI instead of quietly dropping coverage.
grep -Eq '^# skipped 0$' "$output/test.log"
