import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { run } from "effection";
import { luaWorkflowCompiler } from "../../../../packages/flowmode-compiler-lua/src/index.mjs";
import { transpileWorkflowScheme } from "../../../../packages/flowmode-compiler-lua/src/scheme-to-lua.mjs";
import { schemeWorkflowCompiler as workflowCompiler } from "../../../../packages/flowmode-compiler-scheme/src/index.mjs";
import { reviewExports, reviewImports } from "../../tsdown-authoring/contracts.mts";

const source = await readFile(
  new URL("../../../../apps/yo-workflow/execution/review-draft.workflow.ts", import.meta.url),
  "utf8",
);
function compile(compiler, text = source, bindings = reviewImports) {
  return run(() =>
    compiler.compile({
      source: { id: "review-draft.workflow.ts", language: "typescript", text },
      entry: "review_draft",
      exports: reviewExports,
      bindings,
    }),
  );
}

test("one SDK workflow produces separate Scheme and Lua artifacts with the same contracts", async () => {
  const scheme = await compile(workflowCompiler);
  const lua = await compile(luaWorkflowCompiler);
  assert.equal(scheme.ok, true, JSON.stringify(scheme));
  assert.equal(lua.ok, true, JSON.stringify(lua));
  assert.equal(lua.module.implementation.format, "piccolo-lua-module-1");
  assert.notEqual(lua.module.implementation.format, scheme.module.implementation.format);
  assert.deepEqual(lua.module.exports, scheme.module.exports);
  assert.deepEqual(lua.module.imports, scheme.module.imports);
  assert.deepEqual(lua.module.source, scheme.module.source);
  assert.equal(
    lua.module.implementation.payload,
    transpileWorkflowScheme(scheme.module.implementation.payload, "review_draft"),
  );
  assert.deepEqual(lua.module.debug, scheme.module.debug);
  assert.deepEqual(JSON.parse(JSON.stringify(lua.module)), lua.module);
  assert.deepEqual(
    Object.values(lua.module.debug.sites)
      .map((s) => s.key)
      .toSorted((left, right) => left.localeCompare(right)),
    ["approval", "cleanup"],
  );
});

test("Lua uses shared TypeScript diagnostics and rejects undeclared exchanges", async () => {
  const invalidType = await compile(
    luaWorkflowCompiler,
    source.replace('return "Draft approved";', "return 42;"),
  );
  assert.equal(invalidType.ok, false);
  assert.ok(invalidType.diagnostics.some((d) => d.code.startsWith("TS")));
  const missingBinding = await compile(luaWorkflowCompiler, source, reviewImports.slice(0, 1));
  assert.equal(missingBinding.ok, false);
  assert.match(missingBinding.diagnostics[0].message, /Undeclared workflow exchange/);
});

test("unsupported syntax and cleanup captures fail admission rather than changing meaning", async () => {
  for (const [text, message] of [
    [
      source.replace('"use workflow";', '"use workflow"; while (true) {}'),
      /Unsupported workflow Scheme form:.*while/,
    ],
    [
      source.replace('"use workflow";', '"use workflow"; console.log(input);'),
      /Unsupported expression CallExpression/,
    ],
    [
      source.replace('message: "Release the draft reservation?"', "message: answer.action"),
      /Unbound local answer/,
    ],
    [
      source.replace(
        '"use workflow";',
        '"use workflow"; yield* ctx.elicit("approval", { message: input.title, extra: true });',
      ),
      /Compiled elicitation currently supports only/,
    ],
  ]) {
    const result = await compile(luaWorkflowCompiler, text);
    assert.equal(result.ok, false);
    assert.match(result.diagnostics[0].message, message);
  }
});

test("generator construction cannot be mistaken for immediate compiled execution", async () => {
  const text = source.replace(
    '"use workflow";',
    `"use workflow";
    const dormant = function* (): Operation<Reply> {
      return yield* ctx.elicit("approval", { message: input.title });
    };
    const iterator = dormant();`,
  );
  for (const compiler of [workflowCompiler, luaWorkflowCompiler]) {
    const result = await compile(compiler, text);
    assert.equal(result.ok, false);
    assert.match(result.diagnostics[0].message, /Unsupported expression CallExpression/);
  }
});
