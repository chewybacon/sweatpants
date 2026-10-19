import assert from "node:assert/strict";
import { loadMachine } from "../machine.mjs";
import { emitWorkflowScheme } from "../../scheme-compiler/emit.mjs";
const values = [
  null,
  [],
  {},
  ["json-object", "json-null"],
  { sym: "json-null" },
  {
    nested: [
      null,
      {},
      [],
      true,
      false,
      1.25,
      1e-30,
      1e30,
      Number.MIN_VALUE,
      Number.MAX_VALUE,
      0.1,
      '"\\\n\x00\x07\v\f😀',
    ],
  },
  JSON.parse('{"__proto__":{"polluted":true},"constructor":null}'),
];
const source = `(define (workflow)
  (let ((answer (yield-at "read" (list "elicit" "read"))))
    (yield-at "echo" (list "effect" "echo" "1" answer))
    answer)) (workflow)`;
for (const value of values) {
  let machine = await loadMachine();
  machine.start(source);
  const boundary = machine.resume(value);
  assert.deepEqual(boundary.value, ["effect", "echo", "1", value]);
  const snapshot = machine.capture();
  machine = null;
  machine = await loadMachine();
  assert.deepEqual(machine.restore(source, snapshot), boundary);
  assert.equal(machine.capture(), snapshot);
  assert.deepEqual(machine.resume(null), { kind: "returned", site: "", value });
}
// Input uses the same portable boundary as replies, but enters the root environment.
// A fresh instance recovers it from the snapshot without receiving input again.
const inputSource = '(yield-at "ready" %input) %input';
for (const input of values) {
  let original = await loadMachine();
  const parked = original.start(inputSource, input);
  assert.deepEqual(parked, { kind: "effect", site: "ready", value: input });
  const snapshot = original.capture();
  original = null;
  const recovered = await loadMachine();
  assert.deepEqual(recovered.restore(inputSource, snapshot), parked);
  assert.deepEqual(recovered.resume(null), { kind: "returned", site: "", value: input });
}
const inputWorkflow = emitWorkflowScheme(
  `function* workflow(ctx, input) {
        "use workflow";
        const answer = yield* ctx.elicit("approval", input.draft);
        return { draft: input.draft, answer: answer.content };
    }`,
  { entryInput: true },
);
const inputMachine = await loadMachine();
const draft = { subject: "Hello", recipients: ["test"], metadata: null };
assert.deepEqual(inputMachine.start(inputWorkflow.scheme, { draft }).value, [
  "elicit",
  "approval",
  draft,
]);
const recoveredInput = await loadMachine();
recoveredInput.restore(inputWorkflow.scheme, inputMachine.capture());
assert.deepEqual(recoveredInput.resume({ content: "approved" }).value, {
  draft,
  answer: "approved",
});
const compiled = emitWorkflowScheme(
  `function* workflow(ctx) {
 "use workflow";
 const answer = yield* ctx.elicit("approval", { text: "Hello", items: [null, {}, [], 1.25], empty: null });
 return answer.content;
}`,
  { entryInput: true, entryPoint: null },
);
const program = compiled.scheme + "(workflow #f)";
let machine = await loadMachine();
assert.deepEqual(machine.start(program).value, [
  "elicit",
  "approval",
  { text: "Hello", items: [null, {}, [], 1.25], empty: null },
]);
const saved = machine.capture();
for (const invalid of [undefined, NaN, new Date(), { bad: undefined }]) {
  assert.throws(() => machine.resume(invalid));
  assert.equal(machine.capture(), saved);
}
assert.deepEqual(machine.resume({ content: { accepted: true, extra: null } }).value, {
  accepted: true,
  extra: null,
});
machine = await loadMachine();
machine.start(source);
assert.deepEqual(machine.reject({ code: "access_denied", details: [null, {}] }), {
  kind: "thrown",
  site: "",
  value: { code: "access_denied", details: [null, {}] },
});
console.log(
  "PASS Hoot portable values: compiled objects, fields, null, arrays, snapshot recovery and structured errors",
);
