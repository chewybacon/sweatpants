import assert from "node:assert/strict";
import { loadMachine } from "../machine.mjs";
import { parse } from "../../scheme-data/read.mjs";

// Serialize trusted test mutations, retaining dotted bindings from the Scheme reader.
function datum(value) {
    if (Array.isArray(value)) {
        return `(${value.map(datum).join(" ")})`;
    }
    if (typeof value === "string") {
        return JSON.stringify(value);
    }
    if (typeof value === "boolean") {
        return value ? "#t" : "#f";
    }
    if (typeof value === "number") {
        return String(value);
    }
    return value.sym;
}
const symbol = (sym) => ({ sym });
const source = `(define (helper x)
    (ensure (lambda () (yield-at "cleanup" x)))
    (yield-at "answer" x))
  (helper %input)`;
const machine = await loadMachine();
const parked = machine.start(source, { message: "hello" });
const snapshot = machine.capture();
const mutations = [
    ["missing field", (s) => s.pop()],
    ["unknown mode", (s) => (s[5] = symbol("eval"))],
    ["negative steps", (s) => (s[10] = -1)],
    ["fractional steps", (s) => (s[10] = 1.5)],
    ["nonboolean cancellation", (s) => (s[11] = 1)],
    ["unknown outcome", (s) => (s[9] = symbol("break"))],
    ["wrong next environment", (s) => s[3]++],
    ["duplicate environment", (s) => (s[2][0][0] = 0)],
    ["cyclic parent", (s) => (s[2][0][1] = s[2][0][0])],
    ["root has parent", (s) => (s[2].at(-1)[1] = 0)],
    ["missing current environment", (s) => (s[7] = 1000)],
    ["duplicate binding", (s) => s[2][0][2].push(s[2][0][2][0])],
    ["unknown frame", (s) => s[4].push([symbol("unknown")])],
    ["wrong frame arity", (s) => s[4].push([symbol("return"), false])],
    ["missing frame environment", (s) => s[4].push([symbol("sequence"), [], 1000])],
    ["invalid loop phase", (s) => s[4].push([symbol("loop"), true, false, 0, symbol("bad")])],
    ["invalid cleanup callable", (s) => s[4].push([symbol("scope"), symbol("x"), [false]])],
    [
        "dangling cleanup closure",
        (s) =>
            s[4].push([
                symbol("scope"),
                symbol("x"),
                [[symbol("closure"), [], [], 1000, symbol("lambda")]],
            ]),
    ],
    [
        "unknown primitive",
        (s) => s[4].push([symbol("argument"), [symbol("primitive"), symbol("unknown")], [], [], 0]),
    ],
    [
        "nonportable pending value",
        (s) => {
            s[6] = symbol("arbitrary");
            s[8][1] = s[6];
        },
    ],
    [
        "malformed boundary object",
        (s) => {
            s[6] = [symbol("json-object"), [42, false]];
            s[8][1] = s[6];
        },
    ],
    ["missing pending effect", (s) => (s[8] = false)],
    ["nonstring effect site", (s) => (s[8][0] = 42)],
    ["mismatched pending value", (s) => (s[8][1] = "different")],
    [
        "terminal with pending frames",
        (s) => {
            s[5] = symbol("done");
            s[8] = false;
        },
    ],
];
for (const [name, mutate] of mutations) {
    const candidate = parse(snapshot)[0];
    mutate(candidate);
    assert.throws(() => machine.restore(source, datum(candidate)), undefined, name);
    assert.equal(machine.capture(), snapshot, `${name} must not change live state`);
}
const malformed = [
    snapshot + " #f",
    "(",
    " ".repeat(4194305),
    "(".repeat(258) + "#f" + ")".repeat(258),
    "(" + "0 ".repeat(100001) + ")",
];
for (const invalid of malformed) {
    assert.throws(() => machine.restore(source, invalid));
    assert.equal(machine.capture(), snapshot);
}
const fresh = await loadMachine();
assert.deepEqual(fresh.restore(source, snapshot), parked);
assert.equal(fresh.capture(), snapshot, "validation must not advance computation");
assert.deepEqual(machine.resume("accepted"), fresh.resume("accepted"));
const cleanup = fresh.capture();
const recovered = await loadMachine();
recovered.restore(source, cleanup);
assert.deepEqual(recovered.resume(null), { kind: "returned", site: "", value: "accepted" });
const terminal = recovered.capture();
const done = await loadMachine();
assert.deepEqual(done.restore(source, terminal), { kind: "returned", site: "", value: "accepted" });
assert.equal(done.capture(), terminal);
console.log(
    `PASS ${mutations.length + malformed.length} malformed snapshots rejected atomically; parked, cleanup and terminal snapshots restore`,
);
