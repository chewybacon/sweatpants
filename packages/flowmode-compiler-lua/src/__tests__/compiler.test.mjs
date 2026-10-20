import { test, expect } from "vitest";
import { run } from "effection";
import { readFile } from "node:fs/promises";
import { analyzeWorkflowTools, emitTypeScriptWorkflowScheme } from "@sweatpants/flowmode-compiler";
import { luaWorkflowCompiler } from "../index.mjs";
const id = new URL(
  "../../../../apps/yo-workflow/execution/review-draft.workflow.ts",
  import.meta.url,
).pathname;
const text = await readFile(id, "utf8");

test("the public Lua target retains cleanup and rejects unsupported workflow control", async () => {
  const result = await run(() =>
    luaWorkflowCompiler.compile({
      ...analyzeWorkflowTools(text, id)[0],
      source: { id, text, language: "typescript" },
    }),
  );
  expect(result.ok).toBe(true);
  expect(result.module.implementation.payload).toContain("workflow.scope");
  expect(result.module.source.text).toBe(text);
  const invalid = text.replace(
    'return "Draft declined";',
    'while (true) {} return "Draft declined";',
  );
  const rejected = await run(() =>
    luaWorkflowCompiler.compile({
      ...analyzeWorkflowTools(invalid, id)[0],
      source: { id, text: invalid, language: "typescript" },
    }),
  );
  expect(rejected.ok).toBe(false);
  expect(rejected.diagnostics[0].severity).toBe("error");
  expect(typeof emitTypeScriptWorkflowScheme).toBe("function");
}, 30_000);
