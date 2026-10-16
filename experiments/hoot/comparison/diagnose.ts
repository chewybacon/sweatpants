import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { run } from "effection";
import { parseProgram } from "../../../apps/yo-workflow/src/workflow/tisyn.ts";
import { ask } from "../../../apps/yo-workflow/src/workflow/tools/ask.ts";
import { createSchemeDriver, type Machine } from "../evaluation.ts";
const require = createRequire(import.meta.url);
const { Scheme } = require("../runtime/reflect-restricted.cjs") as {
  Scheme: { load_main(path: string, options: { reflect_wasm_dir: string }): Promise<Machine> };
};
for (const path of process.argv.slice(2)) {
  try {
    const { source } = JSON.parse(readFileSync(path, "utf8"));
    if (path.includes("-tisyn-")) parseProgram(source, [ask]);
    else
      await run(function* () {
        const driver = createSchemeDriver(() =>
          Scheme.load_main(fileURLToPath(new URL("../runtime/journal.wasm", import.meta.url)), {
            reflect_wasm_dir: fileURLToPath(new URL("../runtime", import.meta.url)),
          }),
        );
        const handle = yield* driver.open(source);
        try {
          yield* driver.advance(handle);
        } finally {
          yield* driver.close(handle);
        }
      });
    console.log("Source parsed and admitted; no initial evaluator error.");
  } catch (e) {
    console.log(String(e));
  }
}
