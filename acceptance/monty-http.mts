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
    checkpointSha256: createHash("sha256").update(JSON.stringify(view.checkpoint)).digest("hex"),
    events: view.trace.map((entry: { kind: string }) => entry.kind),
  });
  return view;
}
for (const cancel of [false, true]) {
  let view = await request({ action: "start", language: "monty" });
  assert.deepEqual(
    view.operations.map((op: { label: string }) => op.label),
    ["Review draft A", "Review draft B"],
  );
  assert.match(view.programSource, /async def workflow/);
  const act = async (action: string, extra = {}) => {
    view = await request({ action, id: view.id, revision: view.revision, ...extra });
  };
  const reply = async (label: string) => {
    const op = view.operations.find((candidate: { label: string }) => candidate.label === label);
    assert.ok(op, label);
    await act("reply", { operationId: op.id, choice: label });
  };
  await act("restore");
  assert.equal(view.restoration.stateUnchanged, true);
  await reply("Review draft B");
  if (cancel) {
    await act("cancel");
    const pending = structuredClone(view.operations);
    await act("cancel");
    assert.deepEqual(view.operations, pending);
    assert.equal(pending.length, 2);
  }
  await reply("Release draft B");
  assert.equal(view.operations.length, 1);
  await act("restore");
  if (!cancel) {
    await reply("Review draft A");
  }
  await reply("Release draft A");
  assert.deepEqual(
    view.operations.map((op: { label: string }) => op.label),
    ["Finish parent cleanup"],
  );
  if (cancel) {
    await act("cancel");
  }
  await reply("Finish parent cleanup");
  assert.equal(view.status, cancel ? "cancelled" : "completed");
  const loaded = await (await fetch(`${origin}/api/execution?id=${view.id}`)).json();
  assert.equal(loaded.status, view.status);
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
