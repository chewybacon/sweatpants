import { run as runOperation, call } from "effection";
import { createScopedExecution } from "../execution.mts";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomFillSync } from "node:crypto";
import { test } from "node:test";

// Mechanical ABI transport only. No instance or guest handle survives a call.
async function command(module: WebAssembly.Module, request: unknown) {
  const instance: WebAssembly.Instance = await WebAssembly.instantiate(module, {
    host: {
      random_fill(pointer: number, length: number) {
        const memory = instance.exports.memory as WebAssembly.Memory;
        randomFillSync(new Uint8Array(memory.buffer, pointer, length));
      },
    },
  });
  const memory = instance.exports.memory as WebAssembly.Memory;
  const allocate = instance.exports.allocate as (length: number) => number;
  const execute = instance.exports.execute as (pointer: number, length: number) => number;
  const outputLength = instance.exports.output_len as () => number;
  const input = new TextEncoder().encode(JSON.stringify(request));
  const pointer = allocate(input.length);
  new Uint8Array(memory.buffer, pointer, input.length).set(input);
  const output = execute(pointer, input.length);
  return JSON.parse(
    new TextDecoder().decode(new Uint8Array(memory.buffer, output, outputLength())),
  );
}

const module = await WebAssembly.compile(
  await readFile(
    new URL(
      "../lua/target/wasm32-unknown-unknown/release/workflow_scoped_checkpoint_probe.wasm",
      import.meta.url,
    ),
  ),
);
async function run(source: string, action: string, state?: unknown, extra = {}) {
  const response = await command(module, { source, action, state, ...extra });
  assert.equal(response.error, undefined);
  return response.ok;
}

test("shared captures and reverse settlements survive fresh Wasm instances", async () => {
  const source = `local n=0
    local values=workflow.all({
      function() n=n+1; return workflow.effect('a',n) end,
      function() n=n+10; return workflow.effect('b',n) end
    })
    return {values=values, captured=n}`;
  const first = await run(source, "start");
  assert.deepEqual(
    first.boundary.request.pending.map((p: any) => p.request),
    [
      { site: "a", input: 1 },
      { site: "b", input: 11 },
    ],
  );
  const restored = await run(source, "restore", first.state);
  assert.deepEqual(restored, first);
  const second = await run(source, "settle", restored.state, {
    id: 1,
    outcome: { kind: "value", value: 20 },
  });
  assert.equal(second.boundary.request.pending.length, 1);
  const last = await run(source, "settle", second.state, {
    id: 0,
    outcome: { kind: "value", value: 30 },
  });
  assert.deepEqual(last.boundary, { kind: "completed", value: { values: [30, 20], captured: 11 } });
});

for (const winner of ["value", "throw"]) {
  for (const cleanupThrows of [false, true]) {
    test(`race ${winner} drains restored loser cleanup (throws=${cleanupThrows})`, async () => {
      const source = `return workflow.race({
        function() return workflow.effect('winner',0) end,
        function() return workflow.scope(
          function() return workflow.effect('loser',0) end,
          function() workflow.effect('cleanup',0); ${cleanupThrows ? "error('cleanup failed')" : ""} end)
        end
      })`;
      const initial = await run(source, "start");
      const won = await run(source, "settle", initial.state, {
        id: 0,
        outcome: { kind: winner, value: "winner result" },
      });
      assert.deepEqual(
        won.boundary.request.pending.map((p: any) => [p.id, p.intent]),
        [[1, "cancel"]],
      );
      const cleaning = await run(source, "settle", won.state, {
        id: 1,
        outcome: { kind: "cancelled" },
      });
      assert.deepEqual(
        cleaning.boundary.request.pending.map((p: any) => [p.id, p.request.site, p.intent]),
        [[2, "cleanup", "run"]],
      );
      const restored = await run(source, "restore", cleaning.state);
      assert.deepEqual(restored, cleaning);
      const last = await run(source, "settle", restored.state, {
        id: 2,
        outcome: { kind: "value", value: null },
      });
      assert.deepEqual(
        last.boundary,
        winner === "value"
          ? { kind: "completed", value: "winner result" }
          : { kind: "failed", error: "winner result" },
      );
      assert.equal(last.state.suppressed.length, cleanupThrows ? 1 : 0);
    });
  }
}

test("nested scope drains its children before cleanup and parent continuation", async () => {
  const source = `local seen=0
    workflow.scope(function()
      workflow.spawn(function() return workflow.effect('child',0) end)
      workflow.effect('body',0)
    end, function() workflow.effect('cleanup',0); seen=seen+1 end)
    return workflow.effect('after',seen)`;
  const initial = await run(source, "start");
  assert.deepEqual(
    initial.boundary.request.pending.map((p: any) => p.request.site),
    ["body", "child"],
  );
  const exited = await run(source, "settle", initial.state, {
    id: 0,
    outcome: { kind: "value", value: null },
  });
  assert.deepEqual(
    exited.boundary.request.pending.map((p: any) => [p.request.site, p.intent]),
    [["child", "cancel"]],
  );
  const drained = await run(source, "settle", exited.state, {
    id: 1,
    outcome: { kind: "cancelled" },
  });
  assert.deepEqual(
    drained.boundary.request.pending.map((p: any) => p.request.site),
    ["cleanup"],
  );
  const cleaned = await run(source, "settle", drained.state, {
    id: 2,
    outcome: { kind: "value", value: null },
  });
  assert.deepEqual(
    cleaned.boundary.request.pending.map((p: any) => p.request),
    [{ site: "after", input: 1 }],
  );
});

test("repeated cancellation leaves yielding cleanup runnable", async () => {
  const source = `return workflow.scope(function() return workflow.effect('body',0) end,
    function() workflow.effect('cleanup',0) end)`;
  const initial = await run(source, "start");
  const cancelled = await run(source, "cancel", initial.state);
  const cleaning = await run(source, "settle", cancelled.state, {
    id: 0,
    outcome: { kind: "cancelled" },
  });
  assert.deepEqual(
    cleaning.boundary.request.pending.map((p: any) => [p.request.site, p.intent]),
    [["cleanup", "run"]],
  );
  const repeated = await run(source, "cancel", cleaning.state);
  assert.deepEqual(repeated.boundary, cleaning.boundary);
  const finished = await run(source, "settle", repeated.state, {
    id: 1,
    outcome: { kind: "value", value: null },
  });
  assert.deepEqual(finished.boundary, { kind: "cancelled" });
});

test("race follows settlement order rather than child registration order", async () => {
  const source = `return workflow.race({function() return workflow.effect('a',0) end,
    function() return workflow.effect('b',0) end})`;
  const first = await run(source, "start");
  const second = await run(source, "settle", first.state, {
    id: 1,
    outcome: { kind: "throw", value: "second wins" },
  });
  const last = await run(source, "settle", second.state, {
    id: 0,
    outcome: { kind: "value", value: "late first" },
  });
  assert.deepEqual(last.boundary, { kind: "failed", error: "second wins" });
  const duplicate = await command(module, {
    source,
    action: "settle",
    state: last.state,
    id: 1,
    outcome: { kind: "value", value: 0 },
  });
  assert.equal(duplicate.error, "unknown or consumed effect");
});

test("empty all returns an array", async () => {
  const result = await run("return workflow.all({})", "start");
  assert.deepEqual(result.boundary, { kind: "completed", value: [] });
});

test("completed child closures retain shared cells across subsequent restores", async () => {
  const source = `local n=1
    local child=workflow.spawn(function() return function() n=n+1; return n end end)
    local increment=workflow.join(child)
    workflow.effect('park',increment())
    return increment()`;
  const first = await run(source, "start");
  assert.equal(first.boundary.request.pending[0].request.input, 2);
  const restored = await run(source, "restore", first.state);
  assert.deepEqual(restored, first);
  const last = await run(source, "settle", restored.state, {
    id: 0,
    outcome: { kind: "value", value: null },
  });
  assert.deepEqual(last.boundary, { kind: "completed", value: 3 });
});

test("scope exit cancels an unstarted child without running its body", async () => {
  const result = await run(
    `local n=0
    workflow.spawn(function() n=n+1; workflow.effect('must not run',n) end)
    return n`,
    "start",
  );
  assert.deepEqual(result.boundary, { kind: "completed", value: 0 });
  assert.equal(result.state.next_effect, 0);
});

test("all failure cancels siblings and drains their cleanup before throwing", async () => {
  const source = `return workflow.all({
    function() return workflow.effect('fail',0) end,
    function() return workflow.scope(function() return workflow.effect('work',0) end,
      function() workflow.effect('cleanup',0) end) end})`;
  const first = await run(source, "start");
  const failed = await run(source, "settle", first.state, {
    id: 0,
    outcome: { kind: "throw", value: "failed" },
  });
  assert.deepEqual(
    failed.boundary.request.pending.map((p: any) => p.intent),
    ["cancel"],
  );
  const cleaning = await run(source, "settle", failed.state, {
    id: 1,
    outcome: { kind: "cancelled" },
  });
  assert.equal(cleaning.boundary.request.pending[0].request.site, "cleanup");
  const last = await run(source, "settle", cleaning.state, {
    id: 2,
    outcome: { kind: "value", value: null },
  });
  assert.deepEqual(last.boundary, { kind: "failed", error: "failed" });
});

test("aggregate payload uses Execution lifecycle, capture, and disposal", async () => {
  let invocations = 0;
  const source = "return workflow.effect('a',1)";
  const started = await runOperation(() =>
    createScopedExecution({
      source,
      *invoke(request) {
        invocations++;
        return yield* call(() => command(module, request));
      },
    }),
  );
  assert.equal(started.boundary.kind, "suspended");
  if (started.boundary.kind !== "suspended") {
    throw Error("expected suspension");
  }
  const first = started.boundary;
  const saved = await runOperation(() => started.execution.capture());
  assert.equal(invocations, 1);
  await assert.rejects(
    runOperation(() =>
      started.execution.resume(first.suspensionId, {
        id: 42,
        outcome: { kind: "value", value: 0 },
      }),
    ),
    /unknown_or_consumed_effect/,
  );
  assert.equal(invocations, 1);
  const last = await runOperation(() =>
    started.execution.resume(first.suspensionId, { id: 0, outcome: { kind: "value", value: 2 } }),
  );
  assert.deepEqual(last, { kind: "completed", value: 2 });
  await assert.rejects(
    runOperation(() =>
      started.execution.resume(first.suspensionId, { id: 0, outcome: { kind: "value", value: 3 } }),
    ),
    /execution_suspension_mismatch/,
  );
  await runOperation(() => started.execution.dispose());
  assert.equal(invocations, 2);
  await assert.rejects(
    runOperation(() => started.execution.capture()),
    /execution_closed/,
  );
  const restored = await runOperation(() =>
    createScopedExecution({
      source,
      snapshot: saved,
      *invoke(request) {
        return yield* call(() => command(module, request));
      },
    }),
  );
  assert.equal(restored.boundary.kind, "suspended");
  if (restored.boundary.kind !== "suspended") {
    throw Error("expected suspension");
  }
  assert.notEqual(restored.boundary.suspensionId, first.suspensionId);
  assert.deepEqual(await runOperation(() => restored.execution.capture()), saved);
  await runOperation(() => restored.execution.dispose());
});

test("unjoined child failure interrupts parent after its external effect settles", async () => {
  const source = `workflow.spawn(function() error('child failed') end)
    return workflow.effect('parent',0)`;
  const first = await run(source, "start");
  assert.deepEqual(
    first.boundary.request.pending.map((p: any) => [p.request.site, p.intent]),
    [["parent", "cancel"]],
  );
  const last = await run(source, "settle", first.state, { id: 0, outcome: { kind: "cancelled" } });
  assert.deepEqual(last.boundary, { kind: "failed", error: "child failed" });
  assert.deepEqual(last.state.suppressed, []);
});

for (const api of ["sleep", "timebox", "deadline"]) {
  test(`Lua ${api} fails explicitly before starting body or effects`, async () => {
    const result = await run(
      `return workflow.${api}(1000, function()
      return workflow.effect('must-not-start',0)
    end)`,
      "start",
    );
    const { durableTimerUnavailable } = await import("../timers.mts");
    assert.deepEqual(result.boundary, { kind: "failed", error: durableTimerUnavailable });
    assert.equal(result.state.next_effect, 0);
    assert.equal(result.state.tasks.length, 1);
  });
}
