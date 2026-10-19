import { reviewExports, reviewImports } from "../contracts.mts";
import { run } from "effection";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { compileWorkflowModule } from "../plugin.mjs";
const compile = (source, id) =>
  run(() =>
    compileWorkflowModule(source, id, {
      entry: "review_draft",
      exports: reviewExports,
      bindings: reviewImports,
    }),
  );
const source = await readFile(new URL("../review-draft.workflow.ts", import.meta.url), "utf8");
const code = await compile(source, "review-draft.workflow.ts");
const module = await import(`data:text/javascript,${encodeURIComponent(code)}`);
assert.equal(module.reviewDraft.source.text, source);
assert.equal(
  module.reviewDraft.debug.locations.review_draft.line,
  source.slice(0, source.indexOf("function* review_draft")).split("\n").length,
);
await assert.rejects(
  () => compile(source.replace('"use workflow";', ""), "missing.workflow.ts"),
  /use workflow directive/,
);
await assert.rejects(
  () =>
    compile(source.replace(".execute(review_draft)", ".execute(missing)"), "missing.workflow.ts"),
  /unknown workflow entry/,
);
await assert.rejects(
  () => compile(source + '\nconsole.log("side effect");', "unsafe.workflow.ts"),
  /Expected named function/,
);
await assert.rejects(() =>
  compile(
    source.replace(
      'const answer = yield* ctx.elicit("approval", { message: input.title });',
      "const answer = await fetch(input.title);",
    ),
    "async.workflow.ts",
  ),
);
console.log("Build transform rejects unsupported source and preserves source locations");
