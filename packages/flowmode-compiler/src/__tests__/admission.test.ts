import assert from "node:assert/strict";
import { test, expect } from "vitest";
import { analyzeWorkflowTools, workflowSourceDependencies } from "../index.js";
import { readFile } from "node:fs/promises";
const id = new URL(
  "../../../../apps/yo-workflow/execution/review-draft.workflow.ts",
  import.meta.url,
).pathname;
const source = await readFile(id, "utf8");

test("SDK declarations supply contracts without evaluating author code", () => {
  const [declaration] = analyzeWorkflowTools(source, id);
  const input = declaration.exports[0].contract.inputSchema.inputProjection;
  const output = declaration.exports[0].contract.outputSchema.inputProjection;
  assert(input && typeof input === "object" && !Array.isArray(input));
  assert(output && typeof output === "object" && !Array.isArray(output));
  expect(declaration.entry).toBe("review_draft");
  expect(input.required).toEqual(["title", "recipient", "metadata"]);
  expect(output.enum).toEqual(["Draft approved", "Draft declined"]);
  expect(declaration.bindings.map((b) => b.contract.id)).toEqual([
    '["elicit","approval"]',
    '["elicit","cleanup"]',
  ]);
  expect(() =>
    analyzeWorkflowTools(source.replace("z.string()", "loadSchemaFromNetwork()"), id),
  ).toThrow("Unsupported workflow schema");
});

test("directive-free tools stay ordinary; misplaced directives fail closed", () => {
  expect(analyzeWorkflowTools(source.replace('"use workflow";', ""), id)).toEqual([]);
  expect(() =>
    analyzeWorkflowTools('export function* other() { "use workflow"; return 1; }', id),
  ).toThrow("exported createDurableTool");
  expect(analyzeWorkflowTools("// use workflow is a directive", id)).toEqual([]);
  expect(workflowSourceDependencies(source, id)).toEqual([]);
});
