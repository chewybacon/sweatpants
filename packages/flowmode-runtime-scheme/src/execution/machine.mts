import type { HootProcedures } from "./machine-api.mts";
import fs from "node:fs";
import { machineApi } from "./machine-api.mts";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const { Scheme } = createRequire(import.meta.url)("../../generated/reflect.cjs") as {
  Scheme: {
    load_main(path: string, options: { reflect_wasm_dir: string }): Promise<HootProcedures>;
  };
};
const wasm = fileURLToPath(new URL("../../generated/execution/kernel.wasm", import.meta.url));
const reflection = fileURLToPath(new URL("../../generated/", import.meta.url));
export function verifyBuild() {
  const record = JSON.parse(
    fs.readFileSync(new URL("../../generated/execution/manifest.json", import.meta.url), "utf8"),
  );
  const paths = {
    evaluator: "../../scripts/execution/evaluator.scm",
    build: "../../scripts/execution/build.py",
    toolchain: "../../toolchain.json",
    meter: "../../scripts/meter.scm",
    wasm: "../../generated/execution/kernel.wasm",
  };
  for (const [key, path] of Object.entries(paths)) {
    const digest = createHash("sha256")
      .update(fs.readFileSync(new URL(path, import.meta.url)))
      .digest("hex");
    if (digest !== record[key]) {
      throw Error(`Stale Scheme Execution runtime: rebuild ${key}`);
    }
  }
}
export async function loadMachine() {
  verifyBuild();
  return machineApi(await Scheme.load_main(wasm, { reflect_wasm_dir: reflection }));
}
