#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
PROFILE=${AWS_PROFILE:-default}
REGION=${AWS_REGION:-us-east-1}
STATE_FILE=${SWEATPANTS_MICROVM_STATE_FILE:-$ROOT/.sweatpants/lambda-microvm-sandbox.json}
if [[ ${1:-} == "--" ]]; then shift; fi
TASK_ID=${1:-agent-sandbox}
SCRIPTS_JSON=${SWEATPANTS_WORKSPACE_SCRIPTS_JSON-'{}'}
RUN_HOOK_PAYLOAD=$(python3 - "$TASK_ID" "$SCRIPTS_JSON" <<'PY'
import json,sys
scripts=json.loads(sys.argv[2])
if not isinstance(scripts,dict) or any(not isinstance(k,str) or not isinstance(v,str) for k,v in scripts.items()):
    raise SystemExit("SWEATPANTS_WORKSPACE_SCRIPTS_JSON must be a string map")
print(json.dumps({"taskId":sys.argv[1],"activationEpoch":1,"scripts":scripts},separators=(",",":")))
PY
)
mkdir -p "$(dirname "$STATE_FILE")"

aws lambda-microvms run-microvm \
  --profile "$PROFILE" \
  --region "$REGION" \
  --image-identifier arn:aws:lambda:us-east-1:123456789012:microvm-image:sweatpants-durable-sandbox \
  --image-version 7.0 \
  --execution-role-arn arn:aws:iam::123456789012:role/sweatpants-microvm-exec-f9fdea17 \
  --ingress-network-connectors '["arn:aws:lambda:us-east-1:aws:network-connector:aws-network-connector:HTTP_INGRESS","arn:aws:lambda:us-east-1:aws:network-connector:aws-network-connector:SHELL_INGRESS"]' \
  --idle-policy '{"maxIdleDurationSeconds":300,"suspendedDurationSeconds":28800,"autoResumeEnabled":true}' \
  --maximum-duration-in-seconds 28800 \
  --run-hook-payload "$RUN_HOOK_PAYLOAD" \
  --logging '{"cloudWatch":{"logGroup":"/aws/lambda-microvms/sweatpants-durable-sandbox"}}' \
  --output json > "$STATE_FILE"
chmod 600 "$STATE_FILE"
python3 - "$STATE_FILE" <<'PY'
import json,sys
value=json.load(open(sys.argv[1]))
print(f'microvmId={value["microvmId"]}')
print(f'endpoint=https://{value["endpoint"]}')
print('idlePolicy=auto-suspend after 300s; auto-resume enabled')
print('hardLifetime=8h; terminate or externally checkpoint before expiry')
PY
