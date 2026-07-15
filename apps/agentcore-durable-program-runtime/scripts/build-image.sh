#!/usr/bin/env bash
set -euo pipefail

IMAGE_NAME=${IMAGE_NAME:-sweatpants-agentcore-durable-program-runtime}
IMAGE_TAG=${IMAGE_TAG:-local}
REPO_ROOT=$(cd "$(dirname "$0")/../../.." && pwd)

docker buildx build \
  --platform linux/arm64 \
  --load \
  -f "$REPO_ROOT/apps/agentcore-durable-program-runtime/Dockerfile" \
  -t "$IMAGE_NAME:$IMAGE_TAG" \
  "$REPO_ROOT"
