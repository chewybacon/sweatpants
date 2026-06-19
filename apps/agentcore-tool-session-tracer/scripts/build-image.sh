#!/usr/bin/env bash
set -euo pipefail

IMAGE_NAME=${IMAGE_NAME:-sweatpants-agentcore-tool-session-tracer}
IMAGE_TAG=${IMAGE_TAG:-local}
REPO_ROOT=$(cd "$(dirname "$0")/../../.." && pwd)

DOCKER_OUTPUT_ARGS=${DOCKER_OUTPUT_ARGS:---load}

docker build \
  $DOCKER_OUTPUT_ARGS \
  -f "$REPO_ROOT/apps/agentcore-tool-session-tracer/Dockerfile" \
  -t "$IMAGE_NAME:$IMAGE_TAG" \
  "$REPO_ROOT"
