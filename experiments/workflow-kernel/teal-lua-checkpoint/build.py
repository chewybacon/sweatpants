"""Build the Lua kernel for the same Wasm host boundary on Node and Cloudflare."""
from pathlib import Path
import shutil
import subprocess
import sys

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
OUT = REPO / ".artifacts/teal-lua-checkpoint"
if not (OUT / "piccolo").exists():
    subprocess.run([sys.executable, str(HERE / "prepare.py")], check=True)
subprocess.run([
    "docker", "run", "--rm", "-v", f"{REPO}:/work",
    "-w", "/work/experiments/workflow-kernel/teal-lua-checkpoint",
    "-e", "CARGO_HOME=/work/.artifacts/teal-lua-checkpoint/cargo",
    "rust:1.88.0-slim", "sh", "-c",
    "rustup target add wasm32-unknown-unknown && cargo build --locked --release --lib --target wasm32-unknown-unknown",
], check=True)
shutil.copyfile(HERE / "target/wasm32-unknown-unknown/release/teal_lua_checkpoint_spike.wasm", OUT / "kernel.wasm")
print(f"Built {OUT / 'kernel.wasm'}")
