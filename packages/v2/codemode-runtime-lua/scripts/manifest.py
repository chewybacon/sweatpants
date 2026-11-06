"""Verify v2-owned build inputs and both packaged evaluator artifacts."""
from pathlib import Path
import hashlib
import json

ROOT = Path(__file__).resolve().parents[1]

def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def manifest():
    paths = [*sorted((ROOT / 'vm/src').glob('*.rs')),
             *[ROOT / 'vm' / name for name in ['Cargo.toml', 'Cargo.lock', 'prelude.lua', 'piccolo-checkpoint.patch', '.cargo/config.toml']],
             *sorted((ROOT / 'scripts').glob('*.py')), ROOT / 'generated/library-kernel.wasm']
    return {str(path.relative_to(ROOT)): digest(path) for path in paths}

def verify_legacy():
    # Historical provenance is retained data, not a dependency on the v1 checkout.
    original = json.loads((ROOT / 'generated/v1-manifest.json').read_text())
    if digest(ROOT / 'generated/kernel.wasm') != original['generated/kernel.wasm']:
        raise SystemExit('Retained legacy Lua artifact changed')

if __name__ == '__main__':
    verify_legacy()
    if json.loads((ROOT / 'generated/library-manifest.json').read_text()) != manifest():
        raise SystemExit('Lua VM inputs or assets changed; run pnpm wasm:build')
    print('V2 Lua VM sources, library artifact and retained legacy bytes verified')
