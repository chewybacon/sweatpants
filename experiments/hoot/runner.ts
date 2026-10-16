import { readFileSync } from "node:fs";
import { createDurableTool } from "@sweatpants/agent-sdk";
import { assertJson, sha256 } from "@sweatpants/foundation";
import { z } from "zod";
import { ask, askParameters } from "../../apps/yo-workflow/src/workflow/tools/ask.ts";
import { randomValue, randomParameters } from "../../apps/yo-workflow/src/workflow/random.ts";
import { createSchemeEvaluation } from "./evaluation.ts";

// Experimental identity includes the interpreter, bridge, dispatcher and tool contracts.
// A changed binary or host interpretation cannot silently replay an old program.
const fingerprint = sha256(
  JSON.stringify([
    "scheme-journal-spike-v1",
    ...[
      "runtime/journal.wasm",
      "runtime/reflect-restricted.cjs",
      "runtime/reflect.wasm",
      "runtime/wtf8.wasm",
      "evaluation.ts",
      "runner.ts",
      "../../apps/yo-workflow/src/workflow/random.ts",
    ].map((path) => sha256(readFileSync(new URL(path, import.meta.url)).toString("base64"))),
    ask.manifest.digest,
  ]),
);

export const scheme = createDurableTool("scheme-spike")
  .description("Experimental Scheme program with host-bound ask and random effects.")
  .identity({ version: "0.0.1", digest: fingerprint })
  .parameters(z.object({ source: z.string().max(12000) }))
  .output(z.json())
  .execute(function* ({ source }, context) {
    const evaluation = yield* createSchemeEvaluation(source);
    let step = yield* evaluation.next();
    while (!step.done) {
      const { id, data } = step.value;
      const value =
        id === "random"
          ? yield* randomValue(randomParameters.parse(data), context)
          : yield* context.pull({
              kind: "invoke",
              child: {
                id: ask.manifest.programId,
                version: ask.manifest.version,
                digest: ask.manifest.digest,
                input: askParameters.parse(data),
              },
            });
      step = yield* evaluation.next(assertJson(value));
    }
    return step.value;
  });
