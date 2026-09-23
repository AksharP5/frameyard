#!/bin/sh
# Regenerates the macOS icon from the Frameyard source PNG.
set -e
cd "$(dirname "$0")/.."

ICONSET="$(mktemp -d)/icon.iconset"
mkdir -p "$ICONSET"
for s in 16 32 128 256 512; do
  d=$((s * 2))
  sips -z "$s" "$s" assets/frameyard.png --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
  sips -z "$d" "$d" assets/frameyard.png --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o assets/frameyard.icns
rm -rf "$(dirname "$ICONSET")"
echo "wrote assets/frameyard.icns"
