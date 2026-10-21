"""Isolated Hoot experiment; reuse the runtime's pinned compiler and metering pass."""
import hashlib
import json
from pathlib import Path
import subprocess

root = Path(__file__).resolve().parents[3]
runtime = root / "packages/scheme-runtime"
source = Path(__file__).resolve().parent
output = root / ".artifacts/hoot-composition"
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

inputs = {
    "evaluator": source / "evaluator.scm",
    "build": source / "build.py",
    "toolchain": runtime / "toolchain.json",
    "meter": runtime / "scripts/meter.scm",
}
record = {key: hashlib.sha256(path.read_bytes()).hexdigest() for key, path in inputs.items()}
record["wasm"] = hashlib.sha256((output / "kernel.wasm").read_bytes()).hexdigest()
(output / "manifest.json").write_text(json.dumps(record, indent=2) + "\n")

bridge = (runtime / "generated/reflect-worker.mjs").read_text().replace("#scheme-kernel-wasm", "#execution-kernel-wasm")
(output / "reflect-worker.mjs").write_text(bridge)
