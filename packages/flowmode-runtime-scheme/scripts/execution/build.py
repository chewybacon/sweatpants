"""Build the checkpoint evaluator with the shared pinned Hoot toolchain."""
import hashlib
import json
from pathlib import Path
import subprocess

runtime = Path(__file__).resolve().parents[2]
source = Path(__file__).resolve().parent
output = runtime / "generated/execution"
output.mkdir(parents=True, exist_ok=True)
config = json.loads((runtime / "toolchain.json").read_text())
identity = hashlib.sha256((runtime / "toolchain.json").read_bytes()
                         + (runtime / "scripts/Dockerfile").read_bytes()).hexdigest()[:20]
image = "sweatpants-scheme-toolchain:" + identity
script = '''(use-modules (hoot compile) (wasm assemble) (ice-9 binary-ports))
(load "/runtime/scripts/meter.scm")
(call-with-values (lambda () (meter-module (compile-file "/source/evaluator.scm" #:debug-level 0)))
  (lambda (module functions loops)
    (call-with-output-file "/output/kernel.wasm"
      (lambda (port) (put-bytevector port (assemble-wasm module))) #:binary #t)))'''
subprocess.run(["docker", "run", "--rm", "--network=none", "--platform", config["platform"],
                "-v", str(runtime) + ":/runtime:ro", "-v", str(source) + ":/source:ro",
                "-v", str(output) + ":/output", image, "guile", "-c", script], check=True)
print(output / "kernel.wasm")

bridge = (runtime / "generated/reflect-worker.mjs").read_text().replace("#scheme-kernel-wasm", "#execution-kernel-wasm")
(output / "reflect-worker.mjs").write_text(bridge)

(output / "reflect-worker.d.mts").write_text('export const Scheme: { load_main(path: string): Promise<import("../../src/execution/machine-api.mjs").HootProcedures> };\n')

from manifest import manifest
(output / "manifest.json").write_text(json.dumps(manifest(), indent=2) + "\n")
