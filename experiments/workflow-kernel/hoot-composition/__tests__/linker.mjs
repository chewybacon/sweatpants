import { ANY_JSON_SCHEMA_DESCRIPTOR as schema } from "../../../../packages/durable-execution/dist/index.js";
const contract = (name) => ({
  id: name,
  name,
  description: name,
  inputSchema: schema,
  outputSchema: schema,
});
const host = (name, version) => ({
  kind: "host",
  contract: { ...contract(name), id: JSON.stringify(["effect", name, version]) },
  capability: { name, version },
});
const caller = (text) => ({
  source: { id: "caller", language: "scheme", text },
  entry: "workflow",
  exports: [],
  imports: [],
  implementation: { format: HOOT_DEFINITION_FORMAT, payload: text },
  debug: { sites: {}, locations: {} },
});
import { run } from "effection";
import assert from "node:assert/strict";
import { hootLinker, HOOT_DEFINITION_FORMAT } from "../linker.mts";
import { loadMachine } from "../machine.mjs";

const link = (input) => run(() => hootLinker.link(input));

const definition = {
  entry: "review",
  source: { id: "developer", text: "developer source", language: "typescript" },
  exports: [{ name: "review", entry: "review", contract: contract("review") }],
  imports: [],
  implementation: {
    format: HOOT_DEFINITION_FORMAT,
    payload: '(define (review ctx input) (yield-at "approval" (list "elicit" "approval" input)))\n',
  },
  debug: { sites: {}, locations: {} },
};
const input = {
  caller: caller("(define (workflow input) (review input)) (workflow %input)"),
  bindings: [
    { kind: "compiled", contract: contract("review"), module: definition, export: "review" },
    host("notify", "1"),
  ],
};
const linked = await link(input);
assert.equal(linked.format, hootLinker.programFormat);
let machine = await loadMachine();
const waiting = machine.start(linked.payload, "hello");
assert.deepEqual(waiting.value, ["elicit", "approval", "hello"]);
const snapshot = machine.capture();
machine = await loadMachine();
assert.deepEqual(machine.restore(linked.payload, snapshot), waiting);
assert.equal(machine.capture(), snapshot);
assert.equal(machine.resume("accepted").value, "accepted");

await assert.rejects(
  () =>
    link({
      ...input,
      caller: { ...input.caller, source: { id: "wrong", language: "rune", text: "source" } },
    }),
  /Scheme caller/,
);
await assert.rejects(
  () => link({ ...input, bindings: [...input.bindings, input.bindings[0]] }),
  /Duplicate workflow binding/,
);
await assert.rejects(
  () =>
    link({
      ...input,
      bindings: [host("bad) (define x", "1")],
    }),
  /binding name/,
);
await assert.rejects(() => link({ ...input, bindings: [host("notify", "2")] }), /version 1/);
for (const change of [
  { implementation: { format: "rune-unit", payload: "code" } },
  { exports: [{ name: "review", entry: "missing", contract: contract("review") }] },
  { implementation: { format: HOOT_DEFINITION_FORMAT, payload: '(display "side effect")' } },
]) {
  await assert.rejects(() =>
    link({
      ...input,
      bindings: [{ ...input.bindings[0], module: { ...definition, ...change } }],
    }),
  );
}
await assert.rejects(
  () =>
    link({
      ...input,
      caller: caller(") (registered-program () () ()) ("),
    }),
  /Unexpected/,
);
const conflicting = {
  ...definition,
  implementation: { ...definition.implementation, payload: '(define (review ctx input) "other")' },
};
await assert.rejects(
  () =>
    link({
      ...input,
      bindings: [
        input.bindings[0],
        { ...input.bindings[0], contract: contract("other"), module: conflicting },
      ],
    }),
  /Duplicate compiled function/,
);
const shared = await link({
  ...input,
  bindings: [input.bindings[0], { ...input.bindings[0], contract: contract("alias") }],
});
assert.equal(shared.payload.match(/\(define \(review/g).length, 1);
const commented = await link({
  ...input,
  caller: caller(input.caller.source.text + "; comment"),
  bindings: [
    {
      ...input.bindings[0],
      module: {
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
