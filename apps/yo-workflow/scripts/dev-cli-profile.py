"""Run the local playground using an explicitly selected trusted Codex CLI proxy config.

Python 3.11+. Credentials are obtained with the profile's auth command and passed
only in the child environment, never written into the repository or printed.
"""
import argparse
import json
import os
from pathlib import Path
import secrets
import subprocess
import tomllib

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--config', type=Path, required=True)
parser.add_argument('--profile')
parser.add_argument('--port', type=int, default=8112)
args = parser.parse_args()
config = tomllib.loads(args.config.expanduser().read_text())
selected = config | (config['profiles'][args.profile] if args.profile else {})
provider = config['model_providers'][selected['model_provider']]
if provider.get('wire_api') != 'responses':
    raise SystemExit('This launcher requires an OpenAI Responses-compatible CLI proxy.')
auth = provider['auth']
credential = subprocess.run([auth['command'], *auth.get('args', [])], capture_output=True, text=True, check=False)
if credential.returncode or not credential.stdout.strip():
    raise SystemExit('CLI profile credential command failed (output withheld).')
root = Path(__file__).resolve().parents[1]
secret_path = root / '.wrangler' / 'cli-proxy-signing-secret'
secret_path.parent.mkdir(exist_ok=True)
if not secret_path.exists():
    fd = os.open(secret_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as f:
        f.write(secrets.token_hex(32))
env = os.environ | {
    'MODEL_CREDENTIALS': json.dumps({'openai': {'type': 'api_key', 'key': credential.stdout.strip(), 'env': {'OPENAI_BASE_URL': provider['base_url']}}}),
    'PROGRAM_DRIVER_CAPABILITY_SECRET': secret_path.read_text(),
    'DEFAULT_CHAT_MODEL_PROVIDER': 'openai',
    'DEFAULT_CHAT_MODEL_ID': selected['model'],
    'DEFAULT_CHAT_MODEL_THINKING': 'medium',
    'CLOUDFLARE_INCLUDE_PROCESS_ENV': 'true',
    'WORKFLOW_LOCAL_STATE_PATH': '.wrangler/cli-proxy-state',
    'WORKFLOW_DEV_PORT': str(args.port),
}
print(f"Starting local Python playground with CLI profile model {selected['model']} on port {args.port}", flush=True)
for command in [
    ['pnpm', 'exec', 'tsx', 'scripts/prepare-cloudflare.ts'],
    ['pnpm', 'exec', 'astro', 'dev', '--host', '127.0.0.1', '--port', str(args.port), '--strictPort', '--ignore-lock'],
]:
    result = subprocess.run(command, cwd=root, env=env, check=False)
    if result.returncode:
        raise SystemExit(result.returncode)
