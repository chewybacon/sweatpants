import { reviewExports, reviewImports } from "../contracts.mts";
import { requireCompiledWorkflow } from "../../../../packages/flowmode-runtime/src/index.ts";
import { run } from "effection";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { schemeWorkflowCompiler as workflowCompiler } from "../../../../packages/flowmode-compiler-scheme/src/index.mjs";
const source = await readFile(
  new URL("../../../../apps/yo-workflow/execution/review-draft.workflow.ts", import.meta.url),
  "utf8",
);
const compile = async (workflowSource) =>
  requireCompiledWorkflow(
    await run(() =>
      workflowCompiler.compile({
        source: workflowSource,
        entry: "review_draft",
        exports: reviewExports,
        bindings: reviewImports,
      }),
    ),
  );
const definitions = {
  reviewDraft: await compile({ language: "typescript", text: source, id: "review.workflow.ts" }),
};
assert.equal(definitions.reviewDraft.implementation.format, workflowCompiler.definitionFormat);
assert.equal(typeof definitions.reviewDraft.implementation.payload, "string");
assert.equal(definitions.reviewDraft.source.language, workflowCompiler.sourceLanguage);
assert.equal(definitions.reviewDraft.source.text, source);
assert.equal("scheme" in definitions.reviewDraft, false);
assert.deepEqual(JSON.parse(JSON.stringify(definitions)), definitions);
await assert.rejects(
  () => compile({ language: "rune", text: source, id: "wrong.rune" }),
  /TypeScript source/,
);
console.log(
  "PASS compiler contract: portable definitions, explicit source/target and language rejection",
);
