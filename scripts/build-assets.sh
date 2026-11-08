#!/usr/bin/env bash
# Build every ride/stall model with headless Blender into apps/web/public/models (+ manifest.json).
# The .glb files are committed, so players and CI never need Blender; run this after editing assets/blender.
set -euo pipefail
cd "$(dirname "$0")/.."
BLENDER=${BLENDER:-$(command -v blender || echo /Applications/Blender.app/Contents/MacOS/Blender)}
OUT=apps/web/public/models
mkdir -p "$OUT"
MODELS=(carousel teacups wheel swings droptower spookwalk stall restroom)
for m in "${MODELS[@]}"; do
  "$BLENDER" -b --factory-startup -P assets/blender/models.py -- "$OUT" "$m" 2>&1 | grep -E "EXPORTED|Error|Traceback" || true
  [ -s "$OUT/$m.glb" ] || { echo "failed to build $m" >&2; exit 1; }
done
printf '{ "models": [%s] }\n' "$(printf '"%s",' "${MODELS[@]}" | sed 's/,$//')" > "$OUT/manifest.json"
ls -la "$OUT"
