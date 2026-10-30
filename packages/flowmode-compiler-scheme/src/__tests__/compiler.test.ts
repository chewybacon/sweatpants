import { test, expect } from "vitest";
import { run } from "effection";
import { readFile } from "node:fs/promises";
import { analyzeWorkflowTools } from "@sweatpants/flowmode-compiler";
import { schemeWorkflowCompiler } from "../index.js";
const id = new URL(
  "../../../../apps/yo-workflow/execution/review-draft.workflow.ts",
  import.meta.url,
).pathname;
const text = await readFile(id, "utf8");

test("the public Scheme target compiles the actual developer tool and retains inspection sites", async () => {
  const result = await run(() =>
    schemeWorkflowCompiler.compile({
      ...analyzeWorkflowTools(text, id)[0],
      source: { id, text, language: "typescript" },
    }),
  );
  expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
  if (!result.ok) {
    throw new Error(JSON.stringify(result.diagnostics));
  }
  expect(result.module.implementation.format).toBe("workflow-scheme-definitions-v1");
  expect(result.module.source.text).toBe(text);
  expect(
    Object.values(result.module.debug.sites).map((site) =>
      site && typeof site === "object" && !Array.isArray(site) ? site.key : undefined,
    ),
  ).toContain("cleanup");
}, 30_000);

test("inline generator inspection sites point into the original source columns", async () => {
  const inline = `import { createDurableTool } from "@sweatpants/agent-sdk/legacy";
import { z } from "zod";
import type { Operation } from "effection";
export const tool = createDurableTool("tool", { version: "1" }).description("Inline source mapping").parameters(z.object({})).output(z.string()).elicits({ question: { response: z.object({ approved: z.boolean() }) } }).execute(function* (input: {}, ctx: { elicit(key: "question", request: { message: string }): Operation<unknown> }): Operation<string> { "use workflow"; const answer = yield* ctx.elicit("question", { message: "Question?" }); return "done"; });`;
  const result = await run(() =>
    schemeWorkflowCompiler.compile({
      ...analyzeWorkflowTools(inline, id)[0],
      source: { id, text: inline, language: "typescript" },
    }),
  );
  expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
  if (!result.ok) {
    throw new Error(JSON.stringify(result.diagnostics));
  }
  const line = inline.split("\n")[3];
  expect(result.module.debug.sites["tool/answer"]).toMatchObject({
    line: 4,
    column: line.indexOf("yield*"),
  });
  expect(result.module.debug.locations.tool).toEqual({
    line: 4,
    column: line.indexOf("function*"),
  });
}, 30_000);
