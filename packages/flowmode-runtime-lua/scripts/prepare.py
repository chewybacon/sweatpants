"""Assemble the pinned VM with the local experimental checkpoint patch."""
from pathlib import Path
import hashlib
import io
import subprocess
import tarfile
import urllib.request

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
REV = "ce709eb1dae5c543cbc78e7e12bb80249d88c55f"
OUT = REPO / ".artifacts/teal-lua-checkpoint/piccolo"
if OUT.exists():
    raise SystemExit(f"Already prepared: {OUT}; retain it or remove it explicitly before rebuilding")
url = f"https://codeload.github.com/kyren/piccolo/tar.gz/{REV}"
with urllib.request.urlopen(url) as response:
    payload = response.read()
digest = hashlib.sha256(payload).hexdigest()
if digest != "4011bc61b542eccf84e335019e7cb5c7b7c544c375bcc1b2a3b1e40a5fb9a083":
    raise SystemExit("Pinned Piccolo archive digest mismatch")
print(f"Piccolo {REV}; archive sha256={digest}")
OUT.parent.mkdir(parents=True, exist_ok=True)
with tarfile.open(fileobj=io.BytesIO(payload), mode="r:gz") as archive:
    archive.extractall(OUT.parent, filter="data")
(OUT.parent / f"piccolo-{REV}").rename(OUT)
subprocess.run(["patch", "-p1", "--batch", "-i", str(HERE / "piccolo-checkpoint.patch")], cwd=OUT, check=True)
