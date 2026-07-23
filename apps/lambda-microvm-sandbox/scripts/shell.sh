#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
PROFILE=${AWS_PROFILE:-default}
REGION=${AWS_REGION:-us-east-1}
STATE_FILE=${SWEATPANTS_MICROVM_STATE_FILE:-$ROOT/.sweatpants/lambda-microvm-sandbox.json}
read -r MICROVM ENDPOINT < <(python3 - "$STATE_FILE" <<'PY'
import json,sys
value=json.load(open(sys.argv[1]))
print(value['microvmId'], value['endpoint'])
PY
)
SHELL_TOKEN=$(aws lambda-microvms create-microvm-shell-auth-token \
  --profile "$PROFILE" --region "$REGION" \
  --microvm-identifier "$MICROVM" \
  --expiration-in-minutes 15 \
  --query 'authToken."X-aws-proxy-auth"' --output text)
export SHELL_TOKEN ENDPOINT
cd "$ROOT/packages/tool-runtime-agentcore"
node --input-type=module <<'JS'
import process from 'node:process';
import WebSocket from 'ws';

const socket = new WebSocket(`wss://${process.env.ENDPOINT}/shell`, [
  `lambda-microvms.authentication.${process.env.SHELL_TOKEN}`,
  'lambda-microvms',
  'lambda-microvms.port.8022',
]);
process.stdin.setRawMode?.(true);
process.stdin.resume();
process.stdin.on('data', (data) => socket.readyState === WebSocket.OPEN && socket.send(data));
socket.on('message', (data) => process.stdout.write(Buffer.from(data)));
socket.on('open', () => process.stdout.write('\r\nConnected to Lambda MicroVM sandbox.\r\n'));
socket.on('close', () => process.exit(0));
socket.on('error', (error) => { console.error(error.message); process.exit(1); });
process.on('SIGINT', () => socket.close());
JS
