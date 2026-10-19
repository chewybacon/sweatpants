import assert from "node:assert/strict";
import { projectHootInspection } from "../inspection.mts";
import { parse } from "../../scheme-data/read.mjs";
import { executionInspectionSchema } from "../../../../apps/yo-workflow/src/execution/inspection.ts";

// Adapter-level representation checks; the sibling inspection.mjs exercises real Wasm.
const state = parse(`(workflow-state-v3 "source"
    ((0 #f ((x . 1) (f closure () () 0 lambda)))) 1
    ((call f) (scope "nested" ()) (scope root ()))
    parked #f 0 ("ask" ()) returned 0 #f)`)[0];
const boundary = {
    kind: "suspended",
    suspensionId: "live",
    request: { site: "ask", request: ["ask"] },
};
const projected = projectHootInspection(state, boundary);
assert.deepEqual(executionInspectionSchema.parse(projected), projected);
assert.deepEqual(projected.calls, [{ id: "0", name: "f" }]);
assert.deepEqual(projected.environments[0].bindings, [
    { name: "x", value: { kind: "display", text: "1", truncated: false } },
    { name: "f", value: { kind: "closure", name: "lambda", environmentId: "0" } },
]);
assert.equal(projected.unwind[0].label, "nested");
assert.equal("suspensionId" in projected.boundary, false);
projected.boundary.request.request.push("mutated view");
assert.deepEqual(boundary.request.request, ["ask"]);

for (const [internal, external] of [
    ["normal", "normal"],
    ["returned", "return"],
    ["thrown", "throw"],
    ["break", "break"],
    ["continue", "continue"],
    ["cancelled", "cancel"],
]) {
    const candidate = structuredClone(state);
    candidate[4] = [[{ sym: "after-finally" }, { sym: internal }, "retained"]];
    const view = executionInspectionSchema.parse(projectHootInspection(candidate, boundary));
    assert.equal(view.unwind[0].completion.kind, external);
    assert.equal(
        "value" in view.unwind[0].completion,
        ["normal", "return", "throw"].includes(external),
    );
}
for (const terminal of [
    { kind: "completed", value: { ok: true } },
    { kind: "failed", error: "denied" },
    { kind: "cancelled" },
]) {
    assert.deepEqual(
        executionInspectionSchema.parse(projectHootInspection(state, terminal)).boundary,
        terminal,
    );
}
const oversized = structuredClone(state);
oversized[2][0][2].push([{ sym: "long" }, { sym: "." }, "x".repeat(10_000)]);
const shortened = projectHootInspection(oversized, boundary);
assert.equal(shortened.truncated, true);
const long = shortened.environments[0].bindings.find((entry) => entry.name === "long");
assert.equal(long.value.truncated, true);
assert.ok(long.value.text.length <= 2_000);
oversized[2] = Array.from({ length: 2_001 }, (_, id) => [id, false, []]);
assert.equal(projectHootInspection(oversized, boundary).truncated, true);
assert.throws(() => projectHootInspection([{ sym: "unknown" }], boundary), /Unknown inspection/);
console.log(
    "PASS inspection projection: schema, lexical references, completion variants, detachment and limits",
);
