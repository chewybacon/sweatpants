#!/usr/bin/env bash
set -euo pipefail

PROFILE=${AWS_PROFILE:-EngineeringPowerUser-prototype}
if ! exported=$(aws configure export-credentials --profile "$PROFILE" --format env); then
  echo "Unable to obtain AWS credentials for profile $PROFILE" >&2
  echo "Run: aws sso login --profile $PROFILE" >&2
  exit 1
fi
eval "$exported"
unset exported AWS_PROFILE
export AWS_REGION=${AWS_REGION:-us-east-1}

exec pnpm exec tsx scripts/launch-yo-chat-remote.mts
