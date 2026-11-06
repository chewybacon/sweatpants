"""Verify v2 Scheme Execution source, loader and packaged Hoot artifacts."""
from pathlib import Path
import hashlib
import json
ROOT = Path(__file__).resolve().parents[1]
ARTIFACTS = ['kernel.wasm', 'reflect.cjs', 'reflect-worker.mjs', 'reflect.wasm', 'wtf8.wasm']
def manifest(output=None):
    output = output or ROOT / 'generated'
    paths = [ROOT / 'toolchain.json', *sorted((ROOT / 'scripts').glob('*.py')),
             *sorted((ROOT / 'scripts').glob('*.scm')), ROOT / 'scripts/Dockerfile',
             *sorted((ROOT / 'src').rglob('*.ts'))]
    result = {str(p.relative_to(ROOT)): hashlib.sha256(p.read_bytes()).hexdigest() for p in paths}
    result.update({'generated/' + name: hashlib.sha256((output / name).read_bytes()).hexdigest() for name in ARTIFACTS})
    return result
if __name__ == '__main__':
    if manifest() != json.loads((ROOT / 'generated/manifest.json').read_text()):
        raise SystemExit('Scheme inputs or assets changed; run pnpm wasm:build')
    print('V2 Scheme Execution source and artifact hashes verified')
