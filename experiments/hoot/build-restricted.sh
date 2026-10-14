#!/bin/sh
set -eu
cd "$(dirname "$0")"
# Reuse the compiler image built by build.sh.
mkdir -p runtime
docker run --rm -v "$PWD:/spike" local/hoot-spike sh -c '
  hoot compile -fruntime-modules -o runtime/restricted-raw.wasm restricted.scm &&
  guile meter.scm runtime/restricted-raw.wasm runtime/restricted.wasm
'
python3 prepare-restricted.py
