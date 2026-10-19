import assert from "node:assert/strict";
import { test } from "node:test";
import { run } from "effection";
import { invokeWasm } from "../wasm-node.mts";

const source = 'return workflow.effect("tail", {"elicit", "approval", "Approve?"})';

test("a tail-called host effect restores with no remaining Lua frames and returns its reply", async () => {
  await run(function* () {
    const parked = yield* invokeWasm({ action: "start", source, input: null });
    assert.equal((parked.boundary as { kind: string }).kind, "suspended");
    assert.deepEqual((parked.vm as { frames: unknown[] }).frames, []);
    const state = JSON.parse(JSON.stringify(parked));
    const restored = yield* invokeWasm({ action: "restore", source, state });
    assert.deepEqual(restored.boundary, parked.boundary);
    const completed = yield* invokeWasm({
      action: "resume",
      source,
      state: restored,
      reply: { receipt: "sent" },
    });
    assert.deepEqual(completed.boundary, { kind: "completed", value: { receipt: "sent" } });
  });
});

test("a restored tail-called effect can receive a host rejection", async () => {
  await run(function* () {
    const parked = yield* invokeWasm({ action: "start", source, input: null });
    const state = JSON.parse(JSON.stringify(parked));
    const rejected = yield* invokeWasm({ action: "reject", source, state, reply: "host rejected" });
    assert.equal((rejected.boundary as { kind: string }).kind, "failed");
    assert.match(JSON.stringify(rejected.boundary), /host rejected/);
  });
});

test("a restored tail-called effect can be cancelled", async () => {
  await run(function* () {
    const parked = yield* invokeWasm({ action: "start", source, input: null });
    const state = JSON.parse(JSON.stringify(parked));
    const cancelled = yield* invokeWasm({ action: "cancel", source, state, reason: "stop" });
    assert.deepEqual(cancelled.boundary, { kind: "cancelled", reason: "stop" });
  });
});
