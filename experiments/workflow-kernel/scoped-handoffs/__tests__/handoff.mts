import assert from "node:assert/strict";
import { test } from "node:test";
import { createQueue, run, spawn, withResolvers } from "effection";
import { createExecution, type Exchange, type ExecutionBoundary } from "@sweatpants/foundation";
import { handoff } from "../handoff.mts";

test("distinct executions share an exchange and route reverse-order replies to shared cells", async () => {
  await run(function* () {
    const captured = { total: 0 };
    const aReply = withResolvers<number>();
    const bReply = withResolvers<number>();
    const requests = createQueue<string, never>();
    const resumed: string[] = [];
    const exchange: Exchange<string, number> = function* (request) {
      requests.add(request);
      return yield* (request === "a" ? aReply : bReply).operation;
    };
    // Both use the same suspension ID deliberately: IDs belong to executions.
    const a = createExecution<string, number, number>({
      initial: { kind: "suspended", suspensionId: "1", request: "a" },
      driver: {
        *resume(_id, reply) {
          resumed.push("a");
          captured.total += reply;
          return { kind: "completed", value: captured.total };
        },
        *cancel() {
          return { kind: "cancelled" };
        },
        *dispose() {},
      },
    });
    const b = createExecution<string, number, number>({
      initial: { kind: "suspended", suspensionId: "1", request: "b" },
      driver: {
        *resume(_id, reply) {
          resumed.push("b");
          captured.total += reply;
          return { kind: "completed", value: captured.total };
        },
        *cancel() {
          return { kind: "cancelled" };
        },
        *dispose() {},
      },
    });
    try {
      const first = yield* spawn(() => handoff(a, exchange));
      const second = yield* spawn(() => handoff(b, exchange));
      assert.deepEqual(
        [(yield* requests.next()).value, (yield* requests.next()).value],
        ["a", "b"],
      );
      assert.deepEqual(resumed, []);
      bReply.resolve(7);
      assert.deepEqual(yield* second, { kind: "completed", value: 7 });
      aReply.resolve(5);
      assert.deepEqual(yield* first, { kind: "completed", value: 12 });
      assert.deepEqual(resumed, ["b", "a"]);
      assert.equal(captured.total, 12);
      assert.equal("capture" in a.execution, false);
    } finally {
      yield* a.execution.dispose();
      yield* b.execution.dispose();
    }
  });
});

test("a pre-dispatch exchange failure leaves the execution suspended", async () => {
  let advances = 0;
  const state = createExecution<string, number, number>({
    initial: { kind: "suspended", suspensionId: "request", request: "opaque" },
    driver: {
      *resume(_id, reply) {
        advances++;
        return { kind: "completed", value: reply };
      },
      *cancel() {
        return { kind: "cancelled" };
      },
      *dispose() {},
    },
  });
  // No external work was dispatched. Accepted/ambiguous effects require authority
  // reconciliation; retrying this local handoff is not an unsafe-effect policy.
  const unavailable: Exchange<string, number> = function* () {
    throw new Error("transport unavailable");
  };
  await assert.rejects(
    run(() => handoff(state, unavailable)),
    /transport unavailable/,
  );
  assert.equal(advances, 0);
  const reply: Exchange<string, number> = function* () {
    return 42;
  };
  assert.deepEqual(await run(() => handoff(state, reply)), { kind: "completed", value: 42 });
  await assert.rejects(
    run(() => state.execution.resume("request", 99)),
    /execution_suspension_mismatch/,
  );
  assert.equal(advances, 1);
  await run(() => state.execution.dispose());
});

test("terminal boundaries pass through without an exchange or another resume", async () => {
  for (const boundary of [
    { kind: "completed", value: 3 },
    { kind: "failed", error: "guest failure" },
    { kind: "cancelled", reason: "scope exit" },
  ] satisfies ExecutionBoundary<string, number, string>[]) {
    const state = createExecution<string, number, number, string>({
      initial: boundary,
      driver: {
        *resume() {
          throw new Error("terminal resume");
        },
        *cancel() {
          throw new Error("terminal cancel");
        },
        *dispose() {},
      },
    });
    const exchange: Exchange<string, number> = function* () {
      throw new Error("terminal exchange");
    };
    assert.equal(await run(() => handoff(state, exchange)), boundary);
    await run(() => state.execution.dispose());
  }
});
