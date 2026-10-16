import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { compileWorkflow } from "../compiled-frames/compiler.mjs";
import { compile, start, run } from "./engine.mjs";
const { run: effRun, ensure } = createRequire(new URL("../../../package.json", import.meta.url))(
    "effection",
);
for (const bodyFails of [false, true]) {
    const source = `import {ensure} from 'effection';
 function* workflow(ctx) {
  "use workflow";
  yield* ensure(function* () { yield* ctx.elicit("first"); throw "first failed"; });
  yield* ensure(function* () { yield* ctx.elicit("second"); throw "second failed"; });
  ${bodyFails ? 'throw "body failed";' : 'return "done";'}
 }`;
    const compiled = compileWorkflow(source, {
        compileScheme: compile,
        allowEnsure: true,
        allowFinally: true,
        allowScopes: true,
    });
    let result = run(compiled.program, start(compiled.program));
    const trace = [];
    while (result.state.status !== "done") {
        trace.push(result.effect[1]);
        result = run(compiled.program, JSON.parse(JSON.stringify(result.state)), { reply: "ok" });
    }
    const nativeTrace = [];
    let nativeError;
    try {
        await effRun(function* () {
            yield* ensure(function* () {
                nativeTrace.push("first");
                throw "first failed";
            });
            yield* ensure(function* () {
                nativeTrace.push("second");
                throw "second failed";
            });
            if (bodyFails) throw "body failed";
            return "done";
        });
    } catch (error) {
        nativeError = error;
    }
    assert.deepEqual(trace, nativeTrace);
    assert.deepEqual(result.outcome, { kind: "thrown", value: nativeError });
    assert.equal(nativeError, "first failed");
}
console.log("PASS 2 native Effection cleanup-failure precedence scenarios");
