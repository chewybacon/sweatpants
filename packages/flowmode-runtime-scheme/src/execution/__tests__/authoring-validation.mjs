import assert from "node:assert/strict";
import { loadMachine } from "../machine.mjs";
import { machineApi } from "../machine-api.mjs";

// Production bundling renames Hoot's MutableString class.
// oxlint-disable-next-line typescript-eslint/no-extraneous-class -- A renamed class instance models the bundled Hoot value being tested.
class MinifiedString {
  constructor(text) {
    this.text = text;
    this.reflector = { string_value: (value) => value.text };
  }
}
const procedures = Array.from({ length: 8 }, () => ({ call: () => [] }));
procedures.fuel = { value: 0n };
procedures[3] = { call: () => [new MinifiedString("checkpoint")] };
procedures[7] = { call: () => [new MinifiedString("")] };
procedures[6] = { call: () => [new MinifiedString("Expected JSON object")] };
procedures[0] = {
  call: () => {
    throw new Error("Wasm exception");
  },
};
const bundledMachine = machineApi(procedures);
assert.equal(bundledMachine.capture(), "checkpoint");
assert.equal(bundledMachine.validate("source"), "");
assert.throws(() => bundledMachine.start("source"), /Expected JSON object/);

const machine = await loadMachine();
const caller = "(define (workflow input) (review_draft input))\n(workflow %input)";
assert.equal(machine.validate(caller), "");
assert.match(machine.validate(`${caller}\n# Instructions`), /Scheme reader:.*Unknown # object/);
assert.match(machine.validate(`${caller}\nExplanation`), /Expected only definitions/);
assert.match(
  machine.validate('(define (workflow input) (yield-at "x" input)) (workflow %input)'),
  /Unsupported authored caller form/,
);
assert.equal(machine.validate(caller), "", "validation remains usable after reader failure");
console.log("Authoring validation passed");

const { validateCaller } = await import("../../../../apps/yo-workflow/execution/service.mjs");
assert.equal(await validateCaller(caller), "");
assert.match(
  await validateCaller(
    '(define (workflow input) (review_draft (list "title" "x"))) (workflow %input)',
  ),
  /Expected JSON object/,
);
assert.match(
  await validateCaller("(define (workflow input) (send_announcement input)) (workflow %input)"),
  /first request approval/,
);
console.log("Effect-free preflight passed");
