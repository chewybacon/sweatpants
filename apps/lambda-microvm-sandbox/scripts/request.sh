#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
PROFILE=${AWS_PROFILE:-EngineeringPowerUser-prototype}
REGION=${AWS_REGION:-us-east-1}
STATE_FILE=${SWEATPANTS_MICROVM_STATE_FILE:-$ROOT/.sweatpants/lambda-microvm-sandbox.json}
if [[ ${1:-} == "--" ]]; then shift; fi
METHOD=${1:-GET}
PATH_VALUE=${2:-/health}
BODY=${3:-}
read -r MICROVM ENDPOINT < <(python3 - "$STATE_FILE" <<'PY'
import json,sys
value=json.load(open(sys.argv[1]))
print(value['microvmId'], value['endpoint'])
PY
)
TOKEN=$(aws lambda-microvms create-microvm-auth-token \
  --profile "$PROFILE" --region "$REGION" \
  --microvm-identifier "$MICROVM" \
  --expiration-in-minutes 5 \
  --allowed-ports '[{"port":8080}]' \
  --query 'authToken."X-aws-proxy-auth"' --output text)
ARGS=(-fsS -X "$METHOD" "https://$ENDPOINT$PATH_VALUE" -H "X-aws-proxy-auth: $TOKEN" -H 'X-aws-proxy-port: 8080')
if [[ -n "$BODY" ]]; then
  ARGS+=(-H 'content-type: application/json' --data "$BODY")
fi
curl "${ARGS[@]}"
echo
