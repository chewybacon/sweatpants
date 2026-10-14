#!/bin/sh
set -eu
cd "$(dirname "$0")"
docker run --rm -v "$PWD:/spike" local/hoot-spike sh -c '
  hoot compile -fruntime-modules -o runtime/journal-raw.wasm journal.scm &&
  guile meter.scm runtime/journal-raw.wasm runtime/journal.wasm
'
python3 prepare-restricted.py
