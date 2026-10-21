"""Verify committed runtime assets against their build inputs (no Docker needed)."""
import hashlib
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
ARTIFACTS = ["kernel.wasm", "reflect.wasm", "wtf8.wasm", "reflect.cjs",
             "reflect-worker.mjs", "reflect-worker.d.mts", "metering.json", "language.json"]
SOURCES = ["toolchain.json"] + [
    str(path.relative_to(ROOT))
    for directory in ["scripts", "licenses"]
    for path in sorted((ROOT / directory).glob("*"))
    if path.is_file()
]



def manifest(output):
    files = {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in SOURCES}
    files.update({"generated/" + name: hashlib.sha256((output / name).read_bytes()).hexdigest()
                  for name in ARTIFACTS})
    return {"version": 1, "toolchain": json.loads((ROOT / "toolchain.json").read_text()),
            "metering": json.loads((output / "metering.json").read_text()), "files": files}


if __name__ == "__main__":
    output = ROOT / "generated"
    if json.loads((output / "manifest.json").read_text()) != manifest(output):
        raise SystemExit("Scheme inputs or artifacts changed; run pnpm --filter @sweatpants/flowmode-runtime-scheme wasm:build")
    print("Scheme source and generated artifact hashes verified")
