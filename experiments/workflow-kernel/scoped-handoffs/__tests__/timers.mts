import assert from "node:assert/strict";
import { test } from "node:test";
import { run } from "effection";
import {
  scopedTimers,
  DurableTimerWakeupPort,
  DurableTimerNotImplemented,
  durableTimerUnavailable,
} from "../timers.mts";

for (const api of ["sleep", "timebox", "deadline"] as const) {
  test(`${api} cannot silently use process-local time or start work`, async () => {
    let started = false;
    const operation =
      api === "sleep"
        ? scopedTimers.sleep(100)
        : scopedTimers[api](100, function* () {
            started = true;
            return 1;
          });
    await assert.rejects(
      run(function* () {
        yield* operation;
      }),
      (error: unknown) => {
        assert.ok(error instanceof DurableTimerNotImplemented);
        assert.equal(error.code, durableTimerUnavailable.code);
        assert.equal(error.message, durableTimerUnavailable.message);
        return true;
      },
    );
    assert.equal(started, false);
  });
}

for (const operation of ["arm", "disarm"] as const) {
  test(`durable wakeup ${operation} fails closed without infrastructure`, async () => {
    await assert.rejects(
      run(function* () {
        yield* DurableTimerWakeupPort.api.operations[operation]({
          sessionId: "session",
          taskId: "task",
          pullId: "accepted-wait",
          wait: { kind: "wait", key: "timer", notBefore: "2030-01-01T00:00:00.000Z" },
        });
      }),
      DurableTimerNotImplemented,
    );
  });
}
