#!/bin/sh
set -eu
cd "$(dirname "$0")"
docker build -t local/hoot-spike .
mkdir -p runtime
docker run --rm -v "$PWD:/spike" local/hoot-spike \
  hoot compile -fruntime-modules --bundle=runtime -o runtime/kernel.wasm kernel.scm
python3 prepare-worker.py
