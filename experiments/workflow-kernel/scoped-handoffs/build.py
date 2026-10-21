"""Build and test the task checkpoint probe against the pinned patched Lua VM."""
from pathlib import Path
import subprocess
import sys

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
VM = REPO / ".artifacts/flowmode-runtime-lua/piccolo"
if not VM.exists():
    subprocess.run([sys.executable, str(REPO / "packages/flowmode-runtime-lua/scripts/prepare.py")], check=True)
subprocess.run([
    "docker", "run", "--rm", "-v", f"{REPO}:/work",
    "-w", "/work/experiments/workflow-kernel/scoped-handoffs/lua",
    "-e", "CARGO_HOME=/work/.artifacts/flowmode-runtime-lua/cargo",
    "rust:1.88.0-slim", "sh", "-c",
    "cargo test --locked && rustup target add wasm32-unknown-unknown && cargo build --locked --release --target wasm32-unknown-unknown",
], check=True)
