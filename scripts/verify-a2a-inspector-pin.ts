import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pin = JSON.parse(
  readFileSync(resolve(root, "interop/a2a-inspector/inspector.pin.json"), "utf8"),
) as {
  repository: string;
  commit: string;
  locks: { uvLockSha256: string; frontendPackageLockSha256: string };
};
const inspector = process.env["A2A_INSPECTOR_DIR"];
if (!inspector) {
  throw new Error("A2A_INSPECTOR_DIR is required; the interoperability gate may not skip");
}
const checkout = resolve(inspector);
const head = execFileSync("git", ["-C", checkout, "rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
if (head !== pin.commit) {
  throw new Error(`Inspector commit mismatch: expected ${pin.commit}, received ${head}`);
}
assertDigest(resolve(checkout, "uv.lock"), pin.locks.uvLockSha256);
assertDigest(resolve(checkout, "frontend/package-lock.json"), pin.locks.frontendPackageLockSha256);
console.log(`Verified A2A Inspector ${pin.commit} from ${pin.repository}`);

function assertDigest(path: string, expected: string): void {
  const actual = createHash("sha256").update(readFileSync(path)).digest("hex");
  if (actual !== expected) {
    throw new Error(`Inspector lock digest mismatch for ${path}`);
  }
}
