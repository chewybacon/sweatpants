"""Verify checkpoint evaluator build inputs and packaged assets without Docker."""
from pathlib import Path
import hashlib
import json

ROOT = Path(__file__).resolve().parents[2]
PATHS = {
    'evaluator': 'scripts/execution/evaluator.scm',
    'build': 'scripts/execution/build.py',
    'verifier': 'scripts/execution/manifest.py',
    'toolchain': 'toolchain.json',
    'dockerfile': 'scripts/Dockerfile',
    'meter': 'scripts/meter.scm',
    'wasm': 'generated/execution/kernel.wasm',
    'bridge': 'generated/execution/reflect-worker.mjs',
    'types': 'generated/execution/reflect-worker.d.mts',
    'reflection': 'generated/reflect.cjs',
}

def manifest():
    return {key: hashlib.sha256((ROOT / path).read_bytes()).hexdigest() for key, path in PATHS.items()}

if __name__ == '__main__':
    if manifest() != json.loads((ROOT / 'generated/execution/manifest.json').read_text()):
        raise SystemExit('Scheme Execution assets or inputs changed; run pnpm execution:build')
    print('Scheme Execution source and asset hashes verified')
