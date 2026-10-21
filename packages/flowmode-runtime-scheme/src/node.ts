import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createSchemeDriver, type Machine } from "./evaluation.ts";
const require = createRequire(import.meta.url);
const { Scheme } = require("../generated/reflect.cjs") as {
  Scheme: { load_main(path: string, options: { reflect_wasm_dir: string }): Promise<Machine> };
};
export function createNodeSchemeDriver() {
  return createSchemeDriver(() =>
    Scheme.load_main(fileURLToPath(new URL("../generated/kernel.wasm", import.meta.url)), {
      reflect_wasm_dir: fileURLToPath(new URL("../generated/", import.meta.url)),
    }),
  );
}
