"""Compile with a pinned toolchain, stage all artifacts, then publish on success."""
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

from manifest import ARTIFACTS, ROOT, manifest


def run(*args):
    subprocess.run(args, cwd=ROOT, check=True)


def main():
    toolchain = json.loads((ROOT / "toolchain.json").read_text())
    identity = hashlib.sha256((ROOT / "toolchain.json").read_bytes()
                              + (ROOT / "scripts/Dockerfile").read_bytes()).hexdigest()[:20]
    image = "sweatpants-scheme-toolchain:" + identity
    versions = toolchain["packages"]
    run("docker", "build", "--load", "--platform", toolchain["platform"], "-t", image,
        "--build-arg", "BASE_IMAGE=" + toolchain["baseImage"],
        "--build-arg", "DEBIAN_SNAPSHOT=" + toolchain["debianSnapshot"],
        "--build-arg", "HOOT_VERSION=" + versions["guile-hoot"],
        "--build-arg", "GUILE_VERSION=" + versions["guile-3.0"],
        "--build-arg", "GUILE_LIBS_VERSION=" + versions["guile-3.0-libs"], "scripts")
    with tempfile.TemporaryDirectory(prefix="scheme-wasm-") as temporary:
        output = Path(temporary)
        run("docker", "run", "--rm", "--network=none", "--platform", toolchain["platform"],
            "-v", str(ROOT) + ":/build:ro", "-v", str(output) + ":/output", image,
            "guile", "scripts/compile.scm", "/output")
        run(sys.executable, "scripts/prepare.py", str(output))
        (output / "reflect-worker.d.mts").write_text(
            'import type { Machine } from "../src/evaluation.ts";\n'
            'export const Scheme: { load_main(path: string): Promise<Machine> };\n')
        # Native validation happens before replacing any committed artifact.
        run("node", "--input-type=module", "-e",
            'import {readFileSync} from "node:fs";'
            'for(const p of process.argv.slice(1)) new WebAssembly.Module(readFileSync(p));',
            *(str(output / name) for name in ["kernel.wasm", "reflect.wasm", "wtf8.wasm"]))
        generated = ROOT / "generated"
        generated.mkdir(exist_ok=True)
        record = manifest(output)
        if "--verify" in sys.argv:
            expected = json.loads((generated / "manifest.json").read_text())
            if record != expected:
                raise SystemExit("Rebuilt artifacts differ from the committed manifest")
            print("Rebuild matches the committed manifest")
            return
        for name in ARTIFACTS:
            shutil.copyfile(output / name, generated / name)
        # Write the manifest last. Interrupted publication fails wasm:check.
        (generated / "manifest.json").write_text(json.dumps(record, indent=2) + "\n")
        print("Built Scheme WASM with", record["metering"])


if __name__ == "__main__":
    main()
