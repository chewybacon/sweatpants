import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { compileWorkflowModule } from "../plugin.mjs";
const source = await readFile(new URL("../review-draft.workflow.ts", import.meta.url), "utf8");
const code = compileWorkflowModule(source, "review-draft.workflow.ts");
const module = await import(`data:text/javascript,${encodeURIComponent(code)}`);
assert.equal(module.reviewDraft.source, source);
assert.equal(
    module.reviewDraft.debug.locations.review_draft.line,
    source.slice(0, source.indexOf("function* review_draft")).split("\n").length,
);
assert.throws(
    () => compileWorkflowModule(source.replace('"use workflow";', ""), "missing.workflow.ts"),
    /use workflow directive/,
);
assert.throws(
    () =>
        compileWorkflowModule(
            source.replace(
                "defineCompiledWorkflow(review_draft)",
                "defineCompiledWorkflow(missing)",
            ),
            "missing.workflow.ts",
        ),
    /unknown workflow entry/,
);
assert.throws(
    () => compileWorkflowModule(source + '\nconsole.log("side effect");', "unsafe.workflow.ts"),
    /Expected named function/,
);
assert.throws(() =>
    compileWorkflowModule(
        source.replace(
            'const answer = yield* ctx.elicit("approval", input.title);',
            "const answer = await fetch(input.title);",
        ),
        "async.workflow.ts",
    ),
);
console.log("Build transform rejects unsupported source and preserves source locations");
