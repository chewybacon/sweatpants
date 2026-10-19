import assert from "node:assert/strict";
import { emitWorkflowScheme } from "../emit.mjs";
import { compileWorkflow } from "../../compiled-frames/compiler.mjs";

const source = `function* workflow(ctx) {
  "use workflow";
  const answer = yield* ctx.elicit("approve");
  return answer;
}`;
const emitted = emitWorkflowScheme(source);
assert.deepEqual(Object.keys(emitted).sort(), ["debug", "scheme"]);
assert.deepEqual(Object.keys(emitted.debug).sort(), ["locations", "sites"]);
assert.ok(emitted.scheme.includes('(yield-at "workflow/answer" (list "elicit" "approve"))'));
assert.ok(emitted.debug.sites["workflow/answer"]);
assert.deepEqual(emitted.debug.locations.workflow, { line: 1, column: 0 });
const reference = compileWorkflow(source);
assert.equal(reference.scheme, emitted.scheme);
assert.deepEqual(reference.debug.sites, emitted.debug.sites);
assert.deepEqual(reference.debug.locations, emitted.debug.locations);
assert.ok(reference.program.functions[reference.program.entry].code.length);
assert.throws(
  () => emitWorkflowScheme('import { arbitrary } from "library";\n' + source),
  /Unsupported import/,
);
console.log(
  "PASS Scheme-only output, source metadata, reference adapter, unsupported import rejection",
);
const library = emitWorkflowScheme(source, { entryPoint: null });
assert.equal(library.scheme, emitted.scheme.replace("\n(workflow #f)\n", "\n"));
assert.deepEqual(library.debug, emitted.debug);
assert.throws(() => emitWorkflowScheme(source, { entryPoint: "missing" }), /Unknown entry point/);
const named = emitWorkflowScheme(source.replace("workflow(ctx)", "confirm(ctx)"), {
  entryPoint: "confirm",
});
assert.ok(named.scheme.endsWith("\n(confirm #f)\n"));
console.log("PASS definitions-only emission and explicit named entry points");
