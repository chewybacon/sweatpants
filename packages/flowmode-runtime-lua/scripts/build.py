"""Build the pinned Piccolo VM for Node and Workers, then publish verified bytes."""
from pathlib import Path
import json
import shutil
import subprocess
import sys
from manifest import ROOT, manifest

REPO = ROOT.parents[1]
CACHE = REPO / '.artifacts/flowmode-runtime-lua'
if not (CACHE / 'piccolo').exists():
    subprocess.run([sys.executable, str(ROOT / 'scripts/prepare.py')], check=True)
patched = subprocess.run([
    'patch', '--reverse', '--dry-run', '--batch', '-p1', '-i', str(ROOT / 'vm/piccolo-checkpoint.patch'),
], cwd=CACHE / 'piccolo', capture_output=True)
if patched.returncode:
    raise SystemExit(f'Cached Piccolo differs from the pinned patch: remove {CACHE / "piccolo"} and rebuild')
subprocess.run([
    'docker', 'run', '--rm', '-v', f'{REPO}:/work',
    '-w', '/work/packages/flowmode-runtime-lua/vm',
    '-e', 'CARGO_HOME=/work/.artifacts/flowmode-runtime-lua/cargo',
    'rust:1.88.0-slim', 'sh', '-c',
    'rustup target add wasm32-unknown-unknown && cargo build --locked --release --lib --target wasm32-unknown-unknown',
], check=True)
compiled = ROOT / 'vm/target/wasm32-unknown-unknown/release/flowmode_runtime_lua.wasm'
output = ROOT / 'generated/kernel.wasm'
subprocess.run(['node', '--input-type=module', '-e',
                'import {readFileSync} from "node:fs"; new WebAssembly.Module(readFileSync(process.argv[1]));',
                str(compiled)], check=True)
if '--verify' in sys.argv:
    if compiled.read_bytes() != output.read_bytes() or manifest() != json.loads((output.parent / 'manifest.json').read_text()):
        raise SystemExit('Rebuilt Lua VM differs from packaged assets')
else:
    output.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(compiled, output)
    (output.parent / 'manifest.json').write_text(json.dumps(manifest(), indent=2) + '\n')
print('Verified Lua VM:', output)
