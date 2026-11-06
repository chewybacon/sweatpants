"""Build only Scheme Execution using v2-owned sources and a pinned Hoot image."""
import hashlib
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from manifest import ROOT, ARTIFACTS, manifest

def run(*args):
    subprocess.run(args, cwd=ROOT, check=True)

config = json.loads((ROOT / 'toolchain.json').read_text())
identity = hashlib.sha256((ROOT / 'toolchain.json').read_bytes() + (ROOT / 'scripts/Dockerfile').read_bytes()).hexdigest()[:20]
image = 'sweatpants-v2-scheme-toolchain:' + identity
versions = config['packages']
run('docker', 'build', '--load', '--platform', config['platform'], '-t', image,
    '--build-arg', 'BASE_IMAGE=' + config['baseImage'],
    '--build-arg', 'DEBIAN_SNAPSHOT=' + config['debianSnapshot'],
    '--build-arg', 'HOOT_VERSION=' + versions['guile-hoot'],
    '--build-arg', 'GUILE_VERSION=' + versions['guile-3.0'],
    '--build-arg', 'GUILE_LIBS_VERSION=' + versions['guile-3.0-libs'], 'scripts')
with tempfile.TemporaryDirectory(prefix='v2-scheme-') as temporary:
    output = Path(temporary)
    run('docker', 'run', '--rm', '--network=none', '--platform', config['platform'],
        '-v', str(ROOT) + ':/build:ro', '-v', str(output) + ':/output',
        image, 'guile', 'scripts/compile.scm', '/output')
    run(sys.executable, 'scripts/prepare.py', str(output))
    run('node', '--input-type=module', '-e',
        'import {readFileSync} from "node:fs"; for(const p of process.argv.slice(1)) new WebAssembly.Module(readFileSync(p));',
        *(str(output / name) for name in ['kernel.wasm', 'reflect.wasm', 'wtf8.wasm']))
    record = manifest(output)
    generated = ROOT / 'generated'
    if '--verify' in sys.argv:
        if record != json.loads((generated / 'manifest.json').read_text()):
            raise SystemExit('Rebuilt Scheme artifacts differ from the packaged manifest')
        print('V2 Scheme rebuild matches packaged artifacts')
    else:
        generated.mkdir(exist_ok=True)
        for name in ARTIFACTS:
            shutil.copyfile(output / name, generated / name)
        (generated / 'manifest.json').write_text(json.dumps(record, indent=2) + '\n')
        print('Built v2 Scheme Execution artifacts')
