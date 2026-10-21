import assert from "node:assert/strict";
import { source, emitted } from "./fixtures/fixture.mjs";
import { loadMachine } from "../machine.mjs";
import { parse } from "@sweatpants/flowmode-compiler/scheme-data/read";

let machine = await loadMachine();
assert.deepEqual(machine.start(source), {
  kind: "effect",
  site: "workflow/hold",
  value: ["elicit", "reserve"],
});
const waiting = machine.resume({ action: "accept", content: "hold-17" });
assert.deepEqual(waiting, {
  kind: "effect",
  site: "workflow/answer",
  value: ["elicit", "approve", "hold-17"],
});
const saved = machine.capture();
const state = parse(saved)[0];
assert.ok(saved.includes("Caller received: "));
assert.ok(saved.includes("hold-17"));
assert.ok(emitted.debug.sites[waiting.site]);
const callNames = state[4].filter((f) => f[0]?.sym === "call").map((f) => f[1]?.sym);
assert.ok(callNames.includes("workflow") && callNames.includes("caller"));
machine = null;

machine = await loadMachine();
assert.deepEqual(machine.restore(source, saved), waiting);
assert.equal(machine.capture(), saved, "restore must not execute even one evaluator step");
const cleanup = machine.resume({ action: "accept", content: "approved" });
assert.deepEqual(cleanup.value, ["elicit", "release", "hold-17"]);
const cleanupSnapshot = machine.capture();
machine = null;
machine = await loadMachine();
assert.deepEqual(machine.restore(source, cleanupSnapshot), cleanup);
assert.deepEqual(machine.resume({ action: "accept", content: "released" }), {
  kind: "returned",
  site: "",
  value: "Caller received: approved",
});

machine = await loadMachine();
machine.restore(source, saved);
assert.deepEqual(machine.cancel().value, ["elicit", "release", "hold-17"]);
const cancelling = machine.capture();
machine = null;
machine = await loadMachine();
const pendingCleanup = machine.restore(source, cancelling);
assert.deepEqual(machine.cancel(), pendingCleanup, "repeated cancellation must not skip cleanup");
assert.deepEqual(machine.resume({ action: "accept", content: "released" }), {
  kind: "cancelled",
  site: "",
  value: false,
});
assert.throws(() => machine.restore(source + " ", saved), /./);
console.log(
  "PASS Hoot/Wasm: emitted callee, Scheme caller, portable nested state, fresh-instance restore, cleanup and cancellation",
);

machine = await loadMachine();
machine.restore(source, cleanupSnapshot);
assert.deepEqual(
  machine.cancel(),
  cleanup,
  "cancellation during normal cleanup preserves its pending effect",
);
assert.deepEqual(machine.resume({ action: "accept", content: "released" }), {
  kind: "cancelled",
  site: "",
  value: false,
});
console.log("PASS cancellation during normal cleanup and repeated cancellation during unwind");
