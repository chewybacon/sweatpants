import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { workflowCompiler } from "../plugin.mjs";
const source = await readFile(new URL("../review-draft.workflow.ts", import.meta.url), "utf8");
const definitions = workflowCompiler.compile({
    language: "typescript",
    text: source,
    id: "review.workflow.ts",
});
assert.equal(definitions.reviewDraft.implementation.format, workflowCompiler.definitionFormat);
assert.equal(typeof definitions.reviewDraft.implementation.payload, "string");
assert.equal(definitions.reviewDraft.sourceLanguage, workflowCompiler.sourceLanguage);
assert.equal(definitions.reviewDraft.source, source);
assert.equal("scheme" in definitions.reviewDraft, false);
assert.deepEqual(JSON.parse(JSON.stringify(definitions)), definitions);
assert.throws(
    () => workflowCompiler.compile({ language: "rune", text: source }),
    /TypeScript source/,
);
console.log(
    "PASS compiler contract: portable definitions, explicit source/target and language rejection",
);
