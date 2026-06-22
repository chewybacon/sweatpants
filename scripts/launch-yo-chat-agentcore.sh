#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)
RUNTIME_NAME=${AGENTCORE_RUNTIME_NAME:-sweatpants_tool_session_tracer}
REGION=${AWS_REGION:-${AWS_DEFAULT_REGION:-us-east-1}}
ENDPOINT_NAME=${AGENTCORE_ENDPOINT_NAME:-DEFAULT}

if ! command -v aws >/dev/null 2>&1; then
  echo "aws CLI is required" >&2
  exit 1
fi

if ! command -v pnpm >/dev/null 2>&1; then
  echo "pnpm is required" >&2
  exit 1
fi

echo "Checking AWS identity..."
aws sts get-caller-identity >/dev/null

echo "Resolving AgentCore runtime ARN for runtime name: $RUNTIME_NAME"
eval "$(
  cd "$REPO_ROOT/apps/agentcore-tool-session-tracer" && \
  pnpm exec tsx scripts/resolve-runtime-arn.ts \
    --name "$RUNTIME_NAME" \
    --region "$REGION" \
    --endpoint "$ENDPOINT_NAME" \
    --format env
)"

export DEFAULT_CHAT_MODEL_PROVIDER=${DEFAULT_CHAT_MODEL_PROVIDER:-amazon-bedrock}
export DEFAULT_CHAT_MODEL_ID=${DEFAULT_CHAT_MODEL_ID:-zai.glm-5}
export AWS_REGION=${AWS_REGION:-$REGION}
export AWS_DEFAULT_REGION=${AWS_DEFAULT_REGION:-$AWS_REGION}

# If the caller is using an SSO profile, export short-lived credentials so the
# Node AWS SDK path used by Bedrock/pi-ai does not fail on stale profile cache.
if [ -n "${AWS_PROFILE:-}" ] && aws configure export-credentials --profile "$AWS_PROFILE" --format env >/tmp/yo-chat-aws-creds.env 2>/dev/null; then
  # shellcheck disable=SC1091
  source /tmp/yo-chat-aws-creds.env
  unset AWS_PROFILE AWS_DEFAULT_PROFILE
fi

echo "Using AgentCore runtime: $AGENTCORE_RUNTIME_ARN"
echo "Region: $AWS_REGION"
echo "Endpoint: $AGENTCORE_ENDPOINT_NAME"
echo "Chat model: $DEFAULT_CHAT_MODEL_PROVIDER/$DEFAULT_CHAT_MODEL_ID"
echo

if [ "${YO_CHAT_AGENTCORE_RESOLVE_ONLY:-}" = "1" ]; then
  exit 0
fi

echo "Launching yo-chat in AgentCore mode..."
cd "$REPO_ROOT"
exec pnpm dev:yo-chat:agentcore
