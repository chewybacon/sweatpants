#!/usr/bin/env bash
set -euo pipefail
APP_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO_ROOT="$(cd "$APP_ROOT/../.." && pwd)"

cleanup() {
  [[ -z "${AGENT_PID:-}" ]] || kill "$AGENT_PID" 2>/dev/null || true
  [[ -z "${INSPECTOR_PID:-}" ]] || kill "$INSPECTOR_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

pnpm -C "$APP_ROOT" dev &
AGENT_PID=$!
A2A_INSPECTOR_PORT=5001 "$REPO_ROOT/interop/a2a-inspector/launch-inspector.sh" &
INSPECTOR_PID=$!

for _ in $(seq 1 150); do
  if curl -fsS http://127.0.0.1:5001/ >/dev/null 2>&1 && \
     curl -fsS http://127.0.0.1:45681/.well-known/agent-card.json >/dev/null 2>&1; then
    echo "Inspector: http://127.0.0.1:5001/"
    echo "Agent Card: http://127.0.0.1:45681/.well-known/agent-card.json"
    echo "Try: Draw 3 cards"
    open http://127.0.0.1:5001/ 2>/dev/null || true
    wait
    exit 0
  fi
  sleep .2
done

echo "yo-a2a or Inspector failed to become ready" >&2
exit 1
