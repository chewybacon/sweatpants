#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
if [[ ${1:-} == "--" ]]; then shift; fi
OUTPUT=${1:-$ROOT/.artifacts/lambda-microvm-sandbox/code-artifact.zip}
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$(dirname "$OUTPUT")"
cp "$ROOT/apps/lambda-microvm-sandbox/Dockerfile" "$TMP/Dockerfile"
pnpm -C "$ROOT/packages/cli" exec esbuild ../../apps/lambda-microvm-sandbox/src/server.ts \
  --bundle --platform=node --format=esm --target=node24 --outfile="$TMP/server.mjs"
python3 - "$TMP" "$OUTPUT" <<'PY'
import pathlib, sys, zipfile
root = pathlib.Path(sys.argv[1])
output = pathlib.Path(sys.argv[2])
with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
    for name in ("Dockerfile", "server.mjs"):
        info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = 0o100644 << 16
        archive.writestr(info, (root / name).read_bytes())
PY
shasum -a 256 "$OUTPUT"
