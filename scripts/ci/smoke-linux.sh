#!/usr/bin/env bash
set -euo pipefail

: "${XDG_DATA_HOME:?}" "${XDG_CONFIG_HOME:?}" "${TMPDIR:?}"
installed="$XDG_DATA_HOME/diffusion-studio/current"
output="$(dirname "$XDG_DATA_HOME")/smoke"
project="$output/project"
dapi="$installed/resources/cli/bin/dapi"
mkdir -p "$project" "$output/captures"
cat > "$project/package.json" <<'JSON'
{"name":"linux-install-smoke","private":true,"main":"index.tsx"}
JSON
cat > "$project/index.tsx" <<'JSX'
export default function Smoke() {
  return <stage id="smoke-stage">
    <scene id="smoke" width={640} height={360} active>
      <group id="content" end={1}>
        <rect id="background" width={640} height={360} fill="#143a58" />
        <rect id="square" x={80} y={80} width={200} height={200} fill="#f5ba42" />
      </group>
    </scene>
  </stage>;
}
JSX
# Ubuntu runners restrict unprivileged user namespaces. Only this isolated CI
# launch disables Electron's sandbox; release binaries retain their defaults.
env -u ELECTRON_RUN_AS_NODE "$installed/frameyard" --no-sandbox --enable-unsafe-swiftshader --hidden > "$output/electron.log" 2>&1 &
app_pid=$!
export DIFFUSION_APP_EXECUTABLE=/bin/false
trap 'kill "$app_pid" 2>/dev/null || true' EXIT
for attempt in {1..60}; do
  if "$dapi" context > "$output/context.json" 2> "$output/context-error.log"; then break; fi
  kill -0 "$app_pid"
  sleep 1
done
"$dapi" open "$project" --background > "$output/open.json"
"$dapi" context > "$output/open-context.json"
"$dapi" check smoke | tee "$output/check.json"
"$dapi" capture smoke -t 0 0.5 -o "$output/captures" > "$output/capture.json"
"$dapi" export smoke "$output/smoke.mp4" > "$output/export.json"
ffprobe -v error -show_streams -show_format -of json "$output/smoke.mp4" > "$output/probe.json"
node --input-type=module - "$output" <<'JS'
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
const output = process.argv[2];
const context = JSON.parse(readFileSync(join(output, 'open-context.json'), 'utf8'));
assert.equal(context.projectDir, join(output, 'project'));
const check = JSON.parse(readFileSync(join(output, 'check.json'), 'utf8'));
assert.deepEqual(check.issues, []);
assert.equal(check.stats.nodes, 4);
const probe = JSON.parse(readFileSync(join(output, 'probe.json'), 'utf8'));
const video = probe.streams.find(stream => stream.codec_type === 'video');
assert.equal(video?.codec_name, 'h264');
assert.equal(video.width, 1920);
assert.equal(video.height, 1080);
const pixels = execFileSync('ffmpeg', ['-v', 'error', '-i', join(output, 'smoke.mp4'), '-frames:v', '1', '-vf', 'scale=640:360', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1']);
for (const [x, y, expected] of [[20, 20, [20, 58, 88]], [100, 100, [245, 186, 66]]]) {
  const offset = (y * 640 + x) * 3;
  expected.forEach((value, channel) => assert.ok(Math.abs(pixels[offset + channel] - value) <= 6, `Unexpected exported color at ${x},${y}`));
}
assert.ok(Number(probe.format.duration) >= 0.9);
assert.ok(readdirSync(join(output, 'captures')).some(name => name.endsWith('.png') && statSync(join(output, 'captures', name)).size > 100));
JS
