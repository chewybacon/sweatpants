#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
PROFILE=${AWS_PROFILE:-default}
REGION=${AWS_REGION:-us-east-1}
STATE_FILE=${SWEATPANTS_MICROVM_STATE_FILE:-$ROOT/.sweatpants/lambda-microvm-sandbox.json}
ACTION=${1:-state}
MICROVM=$(python3 - "$STATE_FILE" <<'PY'
import json,sys
print(json.load(open(sys.argv[1]))['microvmId'])
PY
)
case "$ACTION" in
  state)
    aws lambda-microvms get-microvm --profile "$PROFILE" --region "$REGION" --microvm-identifier "$MICROVM" --output json
    ;;
  suspend|resume|terminate)
    aws lambda-microvms "$ACTION-microvm" --profile "$PROFILE" --region "$REGION" --microvm-identifier "$MICROVM" --output json
    ;;
  *)
    echo "usage: $0 state|suspend|resume|terminate" >&2
    exit 2
    ;;
esac
