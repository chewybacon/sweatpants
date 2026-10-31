/** Public HTTP acceptance of the actual local Execution DurableObject/D1 application.
 * Start `pnpm --filter yo-workflow execution:demo`, then pass its origin here.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
const origin = process.argv[2] ?? "http://127.0.0.1:8110";
const evidence: unknown[] = [];
async function request(body: Record<string, unknown>) {
  const response = await fetch(`${origin}/api/execution`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const view = await response.json();
  assert.equal(response.status, 200, JSON.stringify(view));
  evidence.push({
    action: body.action,
    id: view.id,
    revision: view.revision,
    status: view.status,
    operations: view.operations,
    restoration: view.restoration,
    source: view.programSource,
    result: view.result,
    checkpointSha256: createHash("sha256").update(JSON.stringify(view.checkpoint)).digest("hex"),
    events: view.trace.map((entry: { kind: string }) => entry.kind),
  });
  return view;
}
for (const cleanup of [false, true]) {
  let view = await request({
    action: "start",
    language: "monty",
    example: cleanup ? "cleanup" : undefined,
  });
  const paths = (state: { operations: { request: { arguments: { path: string } } }[] }) =>
    state.operations.map((op) => op.request.arguments.path);
  assert.deepEqual(
    paths(view),
    cleanup ? ["a.txt", "b.txt"] : ["a.txt", "b.txt", "c.txt", "d.txt", "e.txt"],
  );
  assert.match(view.programSource, /from sandbox import read_file/);
  const act = async (action: string, extra = {}) => {
    view = await request({ action, id: view.id, revision: view.revision, ...extra });
  };
  await act("restore");
  assert.equal(view.restoration.stateUnchanged, true);
  if (cleanup) {
    await act("cancel");
  }
  const settled: string[] = [];
  while (view.operations.length) {
    const pending = structuredClone(view.operations);
    await act("restore");
    assert.deepEqual(view.operations, pending);
    if (cleanup) {
      await act("cancel");
      assert.deepEqual(view.operations, pending);
    }
    const op = view.operations[view.operations.length - 1];
    settled.push(op.request.arguments.path);
    await act("reply", { operationId: op.id, choice: "fixture" });
  }
  if (cleanup) {
    assert.deepEqual(settled.slice(0, 2).toSorted(), ["cleanup-a.txt", "cleanup-b.txt"]);
    assert.equal(settled[2], "session-cleanup.txt");
  } else {
    assert.deepEqual(settled, ["e.txt", "d.txt", "c.txt", "b.txt", "a.txt"]);
    assert.deepEqual(
      view.result.value,
      ["a.txt", "b.txt", "c.txt", "d.txt", "e.txt"].map((path) => `Contents of ${path}`),
    );
  }
  assert.equal(view.status, cleanup ? "cancelled" : "completed");
  const loaded = await (await fetch(`${origin}/api/execution?id=${view.id}`)).json();
  assert.equal(loaded.status, view.status);
}
{
  let view = await request({ action: "start", language: "monty", example: "error" });
  const missing = view.operations[0];
  assert.equal(missing.request.arguments.path, "missing.txt");
  view = await request({ action: "restore", id: view.id, revision: view.revision });
  assert.deepEqual(view.operations[0], missing);
  view = await request({
    action: "reply",
    id: view.id,
    revision: view.revision,
    operationId: missing.id,
    error: { type: "FileNotFoundError", message: "not supplied" },
  });
  assert.equal(view.operations[0].request.arguments.path, "a.txt");
  view = await request({
    action: "reply",
    id: view.id,
    revision: view.revision,
    operationId: view.operations[0].id,
    choice: "fixture",
  });
  assert.equal(view.status, "completed");
  assert.deepEqual(view.result.value, ["not supplied", "Contents of a.txt"]);
}
for (const language of ["scheme", "lua"]) {
  let view = await request({ action: "start", language });
  assert.equal(view.status, "parked");
  assert.equal(view.pending.key, "approval");
  view = await request({ action: "cancel", id: view.id, revision: view.revision });
  assert.equal(view.pending.key, "cleanup");
  view = await request({
    action: "reply",
    id: view.id,
    revision: view.revision,
    choice: "release",
  });
  assert.equal(view.status, "cancelled");
}
console.log(JSON.stringify({ status: "PASS", origin, evidence }, null, 2));
