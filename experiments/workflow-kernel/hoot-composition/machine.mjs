import fs from "node:fs";
import { machineApi } from "./machine-api.mjs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const { Scheme } = createRequire(import.meta.url)(
  "../../../packages/scheme-runtime/generated/reflect.cjs",
);
const wasm = fileURLToPath(
  new URL("../../../.artifacts/hoot-composition/kernel.wasm", import.meta.url),
);
const reflection = fileURLToPath(
  new URL("../../../packages/scheme-runtime/generated/", import.meta.url),
);
export function verifyBuild() {
  const record = JSON.parse(
    fs.readFileSync(
      new URL("../../../.artifacts/hoot-composition/manifest.json", import.meta.url),
      "utf8",
    ),
  );
  const paths = {
    evaluator: "./evaluator.scm",
    build: "./build.py",
    toolchain: "../../../packages/scheme-runtime/toolchain.json",
    meter: "../../../packages/scheme-runtime/scripts/meter.scm",
    wasm: "../../../.artifacts/hoot-composition/kernel.wasm",
  };
  for (const [key, path] of Object.entries(paths)) {
    const digest = createHash("sha256")
      .update(fs.readFileSync(new URL(path, import.meta.url)))
      .digest("hex");
    if (digest !== record[key]) {
      throw Error(`Stale Hoot experiment: rebuild ${key}`);
    }
  }
}
export async function loadMachine() {
  verifyBuild();
  return machineApi(await Scheme.load_main(wasm, { reflect_wasm_dir: reflection }));
}
