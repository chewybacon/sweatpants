import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { emitWorkflowScheme } from "../../scheme-compiler/emit.mjs";
import { compile, start, run as runReference } from "../../compiled-finally/engine.mjs";
import { loadMachine } from "../machine.mjs";
const { run, ensure, scoped } = createRequire(new URL("../../../../package.json", import.meta.url))(
    "effection",
);

function reply(effect) {
    return effect[1] === "reserve" ? `hold-${effect[2]}` : "ok";
}
async function compare(scheme, cancelAt, rejectAt) {
    const program = compile(scheme);
    let state = start(program),
        reference = runReference(program, state);
    let machine = await loadMachine(),
        actual = machine.start(scheme);
    const effects = [];
    let cancelled = false;
    for (let count = 0; count < 30; count++) {
        if (reference.outcome) {
            assert.equal(actual.kind, reference.outcome.kind);
            if (actual.kind !== "cancelled") {
                assert.deepEqual(actual.value, reference.outcome.value);
            }
            const snapshot = machine.capture();
            machine = await loadMachine();
            assert.deepEqual(machine.restore(scheme, snapshot), actual);
            assert.equal(machine.capture(), snapshot, "terminal restoration does not step");
            return { effects, outcome: reference.outcome };
        }
        assert.equal(actual.kind, "effect");
        assert.deepEqual(actual.value, reference.effect);
        assert.equal(actual.site, state.site);
        effects.push(actual.value);
        const snapshot = JSON.parse(JSON.stringify(machine.capture()));
        machine = null;
        machine = await loadMachine();
        assert.deepEqual(machine.restore(scheme, snapshot), actual);
        assert.equal(machine.capture(), snapshot, "restoration does not step");
        state = structuredClone(state);
        if (!cancelled && cancelAt?.(actual.value)) {
            cancelled = true;
            actual = machine.cancel();
            reference = runReference(program, state, { cancel: true });
            // Repeating cancellation at a pending cleanup must not consume it.
            if (actual.kind === "effect") {
                assert.deepEqual(machine.cancel(), actual);
                reference = runReference(program, state, { cancel: true });
            }
        } else if (rejectAt?.(actual.value)) {
            actual = machine.reject("host failed");
            reference = runReference(program, state, { error: "host failed" });
        } else {
            const result = reply(actual.value);
            actual = machine.resume(result);
            reference = runReference(program, state, { reply: result });
        }
    }
    throw Error("Workflow did not terminate");
}
async function native(source, rejectAt) {
    const body = source.replace(/import[^;]+;/g, "");
    // Native parity oracle: execute only the static generator fixtures defined in this file.
    // oxlint-disable-next-line typescript/no-implied-eval
    const workflow = new Function("ensure", "scoped", body + "; return workflow;")(ensure, scoped);
    const effects = [];
    try {
        const value = await run(function* () {
            return yield* workflow({
                *elicit(...args) {
                    const effect = ["elicit", ...args];
                    effects.push(effect);
                    if (rejectAt?.(effect)) {
                        throw "host failed";
                    }
                    return reply(effect);
                },
            });
        });
        return { effects, outcome: { kind: "returned", value } };
    } catch (value) {
        return { effects, outcome: { kind: "thrown", value } };
    }
}

const bodies = {
    normal: `try { yield* ctx.elicit("body"); } finally { yield* ctx.elicit("cleanup"); } return "done";`,
    returned: `try { return "done"; } finally { yield* ctx.elicit("cleanup"); }`,
    thrown: `try { throw "body failed"; } finally { yield* ctx.elicit("cleanup"); }`,
    cleanupFails: `try { return "done"; } finally { yield* ctx.elicit("cleanup"); throw "cleanup failed"; }`,
    bothFail: `try { throw "body failed"; } finally { yield* ctx.elicit("cleanup"); throw "cleanup failed"; }`,
    nested: `try { try { return "done"; } finally { yield* ctx.elicit("inner"); } } finally { yield* ctx.elicit("outer"); }`,
    continueLoop: `let n = 0; while (n < 2) { try { n = n + 1; continue; } finally { yield* ctx.elicit("cleanup", n); } } return n;`,
    breakLoop: `while (true) { try { break; } finally { yield* ctx.elicit("cleanup"); } } return "done";`,
    ensureFailures: `yield* ensure(function* () { yield* ctx.elicit("first"); throw "first failed"; }); yield* ensure(function* () { yield* ctx.elicit("second"); throw "second failed"; }); try { throw "body failed"; } finally { yield* ctx.elicit("cleanup"); throw "finally failed"; }`,
};
for (const [name, body] of Object.entries(bodies)) {
    const source = `import { ensure, scoped } from "effection"; function* workflow(ctx) { "use workflow"; ${body} }`;
    const { scheme } = emitWorkflowScheme(source, {
        allowFinally: true,
        allowEnsure: true,
        allowScopes: true,
    });
    const normal = await compare(scheme);
    assert.deepEqual(normal, await native(source), `native completion: ${name}`);
    const rejectAt = () => true;
    assert.deepEqual(
        await compare(scheme, undefined, rejectAt),
        await native(source, rejectAt),
        `host failure: ${name}`,
    );
    // Cancellation at every distinct effect, including suspended cleanup. Reference
    // parity here; native cancellation has a separate scheduler and is not claimed.
    for (const key of new Set(normal.effects.map((effect) => effect[1]))) {
        await compare(scheme, (effect) => effect[1] === key);
    }
    console.log("PASS fresh-instance finally / error / cancellation", name);
}
