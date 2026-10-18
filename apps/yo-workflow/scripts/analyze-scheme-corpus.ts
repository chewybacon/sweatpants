import { readFile, writeFile } from "node:fs/promises";
import { run } from "effection";
import { createNodeSchemeDriver } from "../../../packages/scheme-runtime/src/node.ts";
import { schemeDiagnostic, limits } from "../../../packages/scheme-runtime/src/evaluation.ts";

// Compile captured submissions only. Never run their effects or replay human replies.
const corpus = JSON.parse(
  await readFile(new URL("../authoring-corpus/bulls-and-cows.json", import.meta.url), "utf8"),
) as {
  attempts: { attempt: number; sha256: string; input: { program: string }; result: unknown }[];
};
const driver = createNodeSchemeDriver();
const measurements = [];
for (const attempt of corpus.attempts) {
  const start = performance.now();
  const result = await run(() => driver.validate(attempt.input.program));
  measurements.push({
    attempt: attempt.attempt,
    sha256: attempt.sha256,
    milliseconds: performance.now() - start,
    result: result.valid
      ? result
      : { valid: false, diagnostic: schemeDiagnostic(result.message, "validation") },
  });
}
const report = { validationFuel: String(limits.validationFuel), measurements };
if (process.argv[2]) {
  await writeFile(process.argv[2], JSON.stringify(report, null, 2) + "\n");
}
console.log(JSON.stringify(report, null, 2));
