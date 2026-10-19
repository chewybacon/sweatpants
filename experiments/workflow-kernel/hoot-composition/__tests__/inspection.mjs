import assert from "node:assert/strict";
import { loadMachine } from "../machine.mjs";
import { source } from "../fixture.mjs";
import { projectHootInspection } from "../inspection.mts";
import { parse } from "../../scheme-data/read.mjs";
import { executionInspectionSchema } from "../../../../apps/yo-workflow/src/execution/inspection.ts";

function boundary(step, id = "original-handle") {
  switch (step.kind) {
    case "effect":
      return {
        kind: "suspended",
        suspensionId: id,
        // These inspection-only fixtures bind each site to its raw payload.
        request: { site: step.site, binding: step.site, input: step.value },
      };
    case "returned":
      return { kind: "completed", value: step.value };
    case "thrown":
      return { kind: "failed", error: step.value };
    case "cancelled":
      return { kind: "cancelled" };
    default:
      throw Error("Unknown boundary");
  }
}

for (const action of ["resume", "cancel", "reject"]) {
  let machine = await loadMachine();
  machine.start(source);
  let step = machine.resume({ content: "reservation" });
  const saved = machine.capture();
  const inspection = executionInspectionSchema.parse(machine.inspect(boundary(step)).execution);
  // The caller's let introduces a real lambda call in the current evaluator.
  assert.deepEqual(
    inspection.calls.map((call) => call.name),
    ["caller", "lambda", "workflow"],
  );
  assert.equal(inspection.boundary.request.site, step.site);
  assert.equal("suspensionId" in inspection.boundary, false);
  assert.ok(inspection.environments.some((env) => env.bindings.some((b) => b.name === "hold")));
  const cleanup = inspection.unwind.find(
    (entry) => entry.kind === "scope" && entry.pendingCleanup.length,
  );
  assert.equal(cleanup.pendingCleanup[0].kind, "closure");
  assert.ok(
    inspection.environments.some((env) => env.id === cleanup.pendingCleanup[0].environmentId),
  );
  assert.equal(machine.capture(), saved, "inspection never advances or mutates execution");
  machine = await loadMachine();
  step = machine.restore(source, saved);
  assert.deepEqual(machine.inspect(boundary(step, "new-handle")).execution, inspection);
  assert.equal(machine.capture(), saved, "restore does not execute the prefix");

  step =
    action === "resume"
      ? machine.resume({ content: "approved" })
      : action === "cancel"
        ? machine.cancel()
        : machine.reject("denied");
  assert.equal(step.kind, "effect");
  const parkedCleanup = machine.capture();
  const cleaning = executionInspectionSchema.parse(machine.inspect(boundary(step)).execution);
  const unwind = cleaning.unwind.find((entry) => entry.kind === "cleanup");
  assert.equal(
    unwind.completion.kind,
    { resume: "return", cancel: "cancel", reject: "throw" }[action],
  );
  assert.equal("scope" in unwind, false, "do not invent erased cleanup ownership");
  machine = await loadMachine();
  step = machine.restore(source, parkedCleanup);
  assert.deepEqual(machine.inspect(boundary(step, "restored-cleanup")).execution, cleaning);
  if (action === "cancel") {
    assert.deepEqual(machine.cancel(), step);
    assert.equal(machine.capture(), parkedCleanup, "repeated cancellation preserves cleanup");
  }
  step = machine.resume(null);
  const terminal = executionInspectionSchema.parse(machine.inspect(boundary(step)).execution);
  assert.equal(
    terminal.boundary.kind,
    { resume: "completed", cancel: "cancelled", reject: "failed" }[action],
  );
  console.log(`PASS inspection: ${action}, caller/callee, environments, cleanup and fresh restore`);
}

// Finally has a pending completion but is not a scope cleanup registration.
const finallySource =
  '(define (workflow) (try-finally (workflow-return "done") (yield-at "finally" (list "release")))) (workflow)';
const machine = await loadMachine();
const step = machine.start(finallySource);
const image = parse(machine.capture())[0];
const inspection = projectHootInspection(image, boundary(step));
assert.deepEqual(inspection.unwind.find((entry) => entry.kind === "finally").completion, {
  kind: "return",
  value: { kind: "display", text: '"done"', truncated: false },
});
assert.equal(inspection.truncated, false);

// Named explicit scopes remain distinct from lexical environment ancestry.
const scopedMachine = await loadMachine();
const scopedSource =
  '(scope "nested" (lambda () (ensure (lambda () (yield-at "release" (list "release")))) (yield-at "body" (list "body"))))';
const scopedStep = scopedMachine.start(scopedSource);
const scopedView = executionInspectionSchema.parse(
  scopedMachine.inspect(boundary(scopedStep)).execution,
);
assert.ok(scopedView.unwind.some((entry) => entry.kind === "scope" && entry.label === "nested"));
assert.equal(
  scopedView.unwind.find((entry) => entry.kind === "scope" && entry.label === "nested")
    .pendingCleanup[0].kind,
  "closure",
);

console.log("PASS inspection: finally and explicit scopes");
