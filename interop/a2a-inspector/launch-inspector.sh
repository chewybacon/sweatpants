#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PIN="8098818f97c6b8554f1f83636508a9608842f5a0"
INSPECTOR_DIR="${A2A_INSPECTOR_DIR:-$ROOT/.cache/a2a-inspector-$PIN}"

if [[ ! -d "$INSPECTOR_DIR/.git" ]]; then
  rm -rf "$INSPECTOR_DIR"
  git init -q "$INSPECTOR_DIR"
  git -C "$INSPECTOR_DIR" remote add origin https://github.com/a2aproject/a2a-inspector.git
  git -C "$INSPECTOR_DIR" fetch --depth 1 origin "$PIN"
  git -C "$INSPECTOR_DIR" checkout -q --detach FETCH_HEAD
fi

A2A_INSPECTOR_DIR="$INSPECTOR_DIR" pnpm -C "$ROOT" verify:a2a-inspector-pin

PATCH="$ROOT/interop/a2a-inspector/patches/task-directed-continuation.patch"
if git -C "$INSPECTOR_DIR" apply --reverse --check "$PATCH" >/dev/null 2>&1; then
  : # already applied
elif git -C "$INSPECTOR_DIR" apply --check "$PATCH"; then
  git -C "$INSPECTOR_DIR" apply "$PATCH"
else
  echo "Pinned Inspector continuation patch does not apply cleanly" >&2
  exit 1
fi

if [[ ! -f "$INSPECTOR_DIR/frontend/node_modules/.sweatpants-locked" ]]; then
  npm --prefix "$INSPECTOR_DIR/frontend" ci
  touch "$INSPECTOR_DIR/frontend/node_modules/.sweatpants-locked"
fi
npm --prefix "$INSPECTOR_DIR/frontend" run build
uv sync --project "$INSPECTOR_DIR" --frozen

cd "$INSPECTOR_DIR/backend"
exec uv run --project .. uvicorn app:app --host 127.0.0.1 --port "${A2A_INSPECTOR_PORT:-5001}"
