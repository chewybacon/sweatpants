import assert from "node:assert/strict";
import { encodeValue, decodeValue } from "../values.mjs";
const values = [
  null,
  false,
  true,
  0,
  -12,
  1.25,
  1e-30,
  1e30,
  Number.MIN_VALUE,
  Number.MAX_VALUE,
  0.1,
  "",
  'quotes " \\; ()',
  "\x00\x07\b\t\n\r\v\f😀",
  [],
  {},
  ["json-object", "json-null"],
  { sym: "json-null" },
  { nested: [null, {}, [], false, { text: "hello" }] },
  JSON.parse('{"__proto__":{"polluted":true},"constructor":null}'),
];
for (const value of values) {
  assert.deepEqual(decodeValue(encodeValue(value)), value);
}
assert.equal({}.polluted, undefined);
const cyclic = {};
cyclic.self = cyclic;
let getterCalls = 0;
const getter = {
  get x() {
    getterCalls++;
    return 1;
  },
};
for (const value of [
  undefined,
  NaN,
  Infinity,
  1n,
  () => {},
  new Date(),
  new Map(),
  cyclic,
  getter,
  [undefined],
  // oxlint-disable-next-line unicorn/no-new-array -- Deliberately sparse: the codec must reject holes.
  new Array(1),
  { x: undefined },
  "\ud800",
]) {
  assert.throws(() => encodeValue(value));
}
assert.equal(getterCalls, 0);
for (const source of ["closure", "(closure 1)", '(json-object ("x"))', "1 2", "+nan.0"]) {
  assert.throws(() => decodeValue(source));
}
console.log(
  "PASS portable codec: JSON distinctions, escaped strings, numbers, hostile keys and rejected host values",
);

const view = new DataView(new ArrayBuffer(8));
let bits = 17n;
for (let i = 0; i < 512; i++) {
  bits = BigInt.asUintN(64, bits * 6364136223846793005n + 1n);
  view.setBigUint64(0, bits);
  const value = view.getFloat64(0);
  if (Number.isFinite(value)) {
    assert.equal(decodeValue(encodeValue(value)), value);
  }
}
console.log("PASS deterministic IEEE-754 transport samples");
