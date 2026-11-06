"""Build v2's pinned Piccolo evaluator without reading or writing a v1 package."""
import json
import shutil
import subprocess
import sys
from manifest import ROOT, manifest, verify_legacy

REPO = ROOT.parents[2]
CACHE = REPO / '.artifacts/v2-codemode-runtime-lua'
verify_legacy()
if not (CACHE / 'piccolo').exists():
    subprocess.run([sys.executable, str(ROOT / 'scripts/prepare.py')], check=True)
patched = subprocess.run([
    'patch', '--reverse', '--dry-run', '--batch', '-p1', '-i', str(ROOT / 'vm/piccolo-checkpoint.patch'),
], cwd=CACHE / 'piccolo', capture_output=True)
if patched.returncode:
    raise SystemExit(f'Cached Piccolo differs from the pinned patch: inspect {CACHE / "piccolo"}')
subprocess.run([
    'docker', 'run', '--rm', '-v', f'{REPO}:/work',
    '-w', '/work/packages/v2/codemode-runtime-lua/vm',
    '-e', 'CARGO_HOME=/work/.artifacts/v2-codemode-runtime-lua/cargo',
    'rust:1.88.0-slim', 'sh', '-c',
    'rustup target add wasm32-unknown-unknown && cargo build --locked --release --lib --target wasm32-unknown-unknown --features standard-library',
], check=True)
compiled = ROOT / 'vm/target/wasm32-unknown-unknown/release/codemode_runtime_lua.wasm'
output = ROOT / 'generated/library-kernel.wasm'
record = output.parent / 'library-manifest.json'
subprocess.run(['node', '--input-type=module', '-e',
                'import {readFileSync} from "node:fs"; new WebAssembly.Module(readFileSync(process.argv[1]));',
                str(compiled)], check=True)
if '--verify' in sys.argv:
    if compiled.read_bytes() != output.read_bytes() or manifest() != json.loads(record.read_text()):
        raise SystemExit('Rebuilt Lua VM differs from packaged assets')
else:
    output.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(compiled, output)
    record.write_text(json.dumps(manifest(), indent=2) + '\n')
print('Verified v2 Lua VM:', output)
