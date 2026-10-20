import assert from "node:assert/strict";
import { source, emitted, resumeApproval, confirmationResult } from "../confirm-action.mjs";
import { loadMachine } from "../machine.mjs";
import { parse } from "../../../../packages/flowmode-compiler/src/scheme-data/read.mjs";

assert.ok(!emitted.scheme.includes("(workflow #f"));
assert.ok(emitted.debug.sites["confirm_action/response"]);
for (const [reply, expected] of [
  [{ action: "accept", content: { approved: true } }, "Draft 17: approved"],
  [{ action: "accept", content: { approved: false } }, "Draft 17: declined"],
  [{ action: "decline" }, "Draft 17: declined"],
]) {
  let machine = await loadMachine();
  const waiting = machine.start(source);
  assert.deepEqual(waiting, {
    kind: "effect",
    site: "confirm_action/response",
    value: ["elicit", "approval", "Approve Draft 17?"],
  });
  const snapshot = machine.capture();
  const frames = parse(snapshot)[0][4];
  const calls = frames.filter((frame) => frame[0]?.sym === "call").map((frame) => frame[1]?.sym);
  assert.ok(calls.includes("caller") && calls.includes("confirm_action"));
  for (const invalid of [true, {}, { action: "accept", content: { approved: "yes" } }]) {
    assert.throws(() => resumeApproval(machine, invalid));
    assert.equal(machine.capture(), snapshot, "invalid replies must not advance execution");
  }
  machine = null;
  machine = await loadMachine();
  assert.deepEqual(machine.restore(source, snapshot), waiting);
  assert.equal(machine.capture(), snapshot, "restoration must not run the prefix");
  assert.deepEqual(resumeApproval(machine, reply), {
    kind: "returned",
    site: "",
    value: expected,
  });
}

// Independently verify the developer function's output contract before the caller consumes it.
const standalone = emitted.scheme + '(confirm_action #f "Approve?")';
const machine = await loadMachine();
machine.start(standalone);
const result = resumeApproval(machine, { action: "accept", content: { approved: true } });
assert.equal(result.kind, "returned");
assert.equal(confirmationResult.parse(result.value), true);
console.log(
  "PASS compiled confirmation + authored caller: typed replies, decline, nested frames and fresh recovery",
);
