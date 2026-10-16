import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { compileWorkflow } from "../../compiled-frames/compiler.mjs";
import { compile, start, run as runReference } from "../../compiled-finally/engine.mjs";
import { loadMachine } from "../machine.mjs";
const { run, ensure, scoped } = createRequire(new URL("../../../../package.json", import.meta.url))(
    "effection",
);

const rootLoop = `
import { ensure } from "effection";
function* register(ctx, hold) {
  "use workflow";
  yield* ensure(function* () { yield* ctx.elicit("release", hold); });
  return hold;
}
function* workflow(ctx) {
  "use workflow";
  let remaining = 3;
  while (remaining > 0) {
    const hold = yield* ctx.elicit("reserve", remaining);
    yield* register(ctx, hold);
    remaining = remaining - 1;
  }
  yield* ctx.elicit("ready");
  return remaining;
}`;
const scopedLoop = `
import { ensure, scoped } from "effection";
function* workflow(ctx) {
  "use workflow";
  let remaining = 3;
  while (remaining > 0) {
    yield* scoped(function* () {
      const hold = yield* ctx.elicit("reserve", remaining);
      let local = 0;
      yield* ensure(function* () { yield* ctx.elicit("release", hold, remaining, local); });
      local = local + 1;
      return hold;
    });
    remaining = remaining - 1;
  }
  yield* ctx.elicit("ready");
  return remaining;
}`;
const sharedLoop = `
import { ensure } from "effection";
function* workflow(ctx) {
  "use workflow";
  let remaining = 3;
  while (remaining > 0) {
    const hold = yield* ctx.elicit("reserve", remaining);
    let local = 0;
    yield* ensure(function* () { yield* ctx.elicit("release", hold, remaining, local); });
    local = local + 1;
    remaining = remaining - 1;
  }
  yield* ctx.elicit("ready");
  return remaining;
}`;
const nestedScopes = `
import { ensure, scoped } from "effection";
function* workflow(ctx) {
  "use workflow";
  yield* ensure(function* () { yield* ctx.elicit("release", "root"); });
  yield* scoped(function* () {
    yield* ensure(function* () { yield* ctx.elicit("release", "outer"); });
    yield* scoped(function* () {
      yield* ensure(function* () { yield* ctx.elicit("release", "inner-first"); });
      yield* ensure(function* () { yield* ctx.elicit("release", "inner-second"); });
      yield* ctx.elicit("ready");
      return 1;
    });
    yield* ctx.elicit("after-inner");
    return 2;
  });
  yield* ctx.elicit("after-outer");
  return 3;
}`;
function reply(effect) {
    return effect[1] === "reserve" ? `hold-${effect[2]}` : "ok";
}
async function compare(scheme, cancelAt) {
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
            if (actual.kind === "returned") {
                assert.deepEqual(actual.value, reference.outcome.value);
            }
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
        } else {
            const result = reply(actual.value);
            actual = machine.resume(result);
            reference = runReference(program, state, { reply: result });
        }
    }
    throw Error("Workflow did not terminate");
}
async function native(source) {
    const body = source.replace(/import[^;]+;/g, "");
    // Native parity oracle: execute only the static generator fixtures defined in this file.
    // oxlint-disable-next-line typescript/no-implied-eval
    const workflow = new Function("ensure", "scoped", body + "; return workflow;")(ensure, scoped);
    const effects = [];
    const value = await run(function* () {
        return yield* workflow({
            *elicit(...args) {
                const effect = ["elicit", ...args];
                effects.push(effect);
                return reply(effect);
            },
        });
    });
    return { effects, outcome: { kind: "returned", value } };
}
for (const [name, source] of Object.entries({
    rootLoop,
    scopedLoop,
    sharedLoop,
    nestedScopes,
    continueLoop: scopedLoop.replace(
        "remaining = remaining - 1;",
        "remaining = remaining - 1; continue;",
    ),
    breakLoop: scopedLoop.replace(
        "remaining = remaining - 1;",
        "remaining = remaining - 1; if (remaining === 1) break;",
    ),
})) {
    const { scheme } = compileWorkflow(source, {
        allowFinally: true,
        allowEnsure: true,
        allowScopes: true,
        compileScheme: compile,
    });
    const normal = await compare(scheme);
    assert.deepEqual(normal, await native(source), `native Effection parity: ${name}`);
    for (const key of ["ready", "release"]) {
        const cancelled = await compare(scheme, (effect) => effect[1] === key);
        assert.equal(cancelled.outcome.kind, "cancelled");
    }
    console.log(
        "PASS fresh-instance Hoot, reference evaluator, and native Effection",
        name,
        normal.effects,
    );
}
const closures = `
(define (workflow)
  (let ((shared 0))
    (let ((get (lambda () shared)) (increment (lambda () (set! shared (+ shared 1)))))
      (ensure (lambda () (yield-at "cleanup" (list "elicit" "release" (get)))))
      (yield-at "before" (list "elicit" "before" (get)))
      (increment)
      (yield-at "after" (list "elicit" "after" (get)))
      (increment)
      (get))))
(workflow)`;
const result = await compare(closures);
assert.deepEqual(result.effects, [
    ["elicit", "before", 0],
    ["elicit", "after", 1],
    ["elicit", "release", 2],
]);
assert.deepEqual(result.outcome, { kind: "returned", value: 2 });
console.log("PASS shared closure environment identity across capture, mutation, and cleanup");
