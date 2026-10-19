import assert from "node:assert/strict";
import { hootLinker, HOOT_DEFINITION_FORMAT } from "../linker.mts";
import { loadMachine } from "../machine.mjs";

const definition = {
    kind: "compiled-workflow",
    entry: "review",
    source: "developer source",
    sourceLanguage: "typescript",
    implementation: {
        format: HOOT_DEFINITION_FORMAT,
        payload: '(define (review ctx input) (yield-at "approval" (list "elicit" "approval" input)))\n',
    },
    debug: { sites: {}, locations: {} },
};
const input = {
    caller: {
        language: "scheme",
        text: "(define (workflow input) (review input)) (workflow %input)",
    },
    bindings: [
        { kind: "compiled", name: "review", definition, prefixArguments: [false] },
        { kind: "host", name: "notify", version: "1" },
    ],
};
const linked = hootLinker.link(input);
assert.equal(linked.format, hootLinker.programFormat);
let machine = await loadMachine();
const waiting = machine.start(linked.payload, "hello");
assert.deepEqual(waiting.value, ["elicit", "approval", "hello"]);
const snapshot = machine.capture();
machine = await loadMachine();
assert.deepEqual(machine.restore(linked.payload, snapshot), waiting);
assert.equal(machine.capture(), snapshot);
assert.equal(machine.resume("accepted").value, "accepted");

assert.throws(
    () => hootLinker.link({ ...input, caller: { language: "rune", text: "source" } }),
    /Scheme caller/,
);
assert.throws(
    () => hootLinker.link({ ...input, bindings: [...input.bindings, input.bindings[0]] }),
    /Duplicate workflow binding/,
);
assert.throws(
    () =>
        hootLinker.link({
            ...input,
            bindings: [{ kind: "host", name: "bad) (define x", version: "1" }],
        }),
    /binding name/,
);
assert.throws(
    () => hootLinker.link({ ...input, bindings: [{ kind: "host", name: "notify", version: "2" }] }),
    /version 1/,
);
for (const change of [
    { implementation: { format: "rune-unit", payload: "code" } },
    { entry: "missing" },
    { implementation: { format: HOOT_DEFINITION_FORMAT, payload: '(display "side effect")' } },
]) {
    assert.throws(() =>
        hootLinker.link({
            ...input,
            bindings: [{ ...input.bindings[0], definition: { ...definition, ...change } }],
        }),
    );
}
assert.throws(
    () =>
        hootLinker.link({
            ...input,
            caller: { language: "scheme", text: ") (registered-program () () ()) (" },
        }),
    /Unexpected/,
);
const conflicting = {
    ...definition,
    implementation: { ...definition.implementation, payload: '(define (review ctx input) "other")' },
};
assert.throws(
    () =>
        hootLinker.link({
            ...input,
            bindings: [
                input.bindings[0],
                { ...input.bindings[0], name: "other", definition: conflicting },
            ],
        }),
    /Duplicate compiled function/,
);
const shared = hootLinker.link({
    ...input,
    bindings: [input.bindings[0], { ...input.bindings[0], name: "alias" }],
});
assert.equal(shared.payload.match(/\(define \(review/g).length, 1);
const commented = hootLinker.link({
    ...input,
    caller: { ...input.caller, text: input.caller.text + "; comment" },
    bindings: [
        {
            ...input.bindings[0],
            definition: {
                ...definition,
                implementation: {
                    ...definition.implementation,
                    payload: definition.implementation.payload + "; comment",
                },
            },
        },
    ],
});
assert.equal((await loadMachine()).start(commented.payload, "hello").kind, "effect");
console.log(
    "PASS Hoot linking: typed definitions, bindings, format rejection, collisions and fresh restore",
);
