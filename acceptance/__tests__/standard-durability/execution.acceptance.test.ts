import { describe, expect, it } from "vitest";
import { call, run } from "effection";
import { Effect } from "effect";
import { effectProgram, type EffectYield } from "@sweatpants/standard-durability-effect";
import type { EffectionYield } from "@sweatpants/standard-durability-effection";
import type { Operation, Work } from "@sweatpants/standard-durability";
import { createGuest, type Guest, type Turn } from "@sweatpants/foundation/computation";
import {
  createCheckpointExecution,
  type ExecutionBoundary,
} from "@sweatpants/foundation/execution";

interface Host<Y> {
  start<T>(work: Work<T, Y>): { result: Promise<T>; cancel(): Promise<void> };
  wait<T>(promise: Promise<T>): Operation<T, Y>;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function scenarios<Y>(name: string, host: Host<Y>) {
  describe(`portable execution ownership: ${name}`, () => {
    it("keeps an interrupted transport outcome unknown and allows joined disposal", async () => {
      const entered = deferred<void>();
      const released = deferred<void>();
      const cleanupStarted = deferred<void>();
      const cleanupReleased = deferred<void>();
      let attempts = 0;
      let disposals = 0;
      const guest: Guest<number, string, Y, number> = createGuest({
        *start() {
          return { kind: "suspended", request: "approve" };
        },
        *resume() {
          attempts++;
          entered.resolve();
          yield* host.wait(released.promise);
          return { kind: "completed", value: 42 };
        },
        *close() {
          cleanupStarted.resolve();
          yield* host.wait(cleanupReleased.promise);
          disposals++;
        },
      });
      const activation = host.start(function* () {
        yield* guest.start();
        return yield* guest.resume({ ok: true, value: 1 });
      });
      const interrupted = activation.result.catch(() => "interrupted");
      await entered.promise;
      await expect(host.start(() => guest.resume({ ok: true, value: 2 })).result).rejects.toThrow(
        "execution_command_in_progress",
      );
      await activation.cancel();
      expect(await interrupted).toBe("interrupted");
      await expect(host.start(() => guest.resume({ ok: true, value: 2 })).result).rejects.toThrow(
        "execution_outcome_unknown",
      );
      expect(attempts).toBe(1);
      const cleanup = host.start(() => guest.close());
      await cleanupStarted.promise;
      expect(disposals).toBe(0);
      cleanupReleased.resolve();
      await cleanup.result;
      await host.start(() => guest.close()).result;
      expect(disposals).toBe(1);
      await expect(host.start(() => guest.start()).result).rejects.toThrow("execution_closed");
      released.resolve();
    });

    it("joins yielding generator finalizers before cancellation completes", async () => {
      const entered = deferred<void>();
      const pending = deferred<void>();
      const cleaning = deferred<void>();
      const release = deferred<void>();
      let disposed = false;
      let cancelled = false;
      const execution = host.start(function* () {
        try {
          entered.resolve();
          yield* host.wait(pending.promise);
        } finally {
          cleaning.resolve();
          yield* host.wait(release.promise);
          disposed = true;
        }
      });
      const result = execution.result.catch(() => "interrupted");
      await entered.promise;
      const cancellation = execution.cancel().then(() => {
        cancelled = true;
      });
      await cleaning.promise;
      expect(disposed).toBe(false);
      expect(cancelled).toBe(false);
      release.resolve();
      await cancellation;
      expect(disposed).toBe(true);
      expect(await result).toBe("interrupted");
      pending.resolve();
    });

    it("runs checkpoint and suspending cancellation through the same portable execution API", async () => {
      const captureStarted = deferred<void>();
      const captureReleased = deferred<void>();
      const trace: string[] = [];
      type Boundary = ExecutionBoundary<string, number, string>;
      const state = createCheckpointExecution({
        initial: { kind: "suspended", suspensionId: "question", request: "approve" } as Boundary,
        driver: {
          *resume(id: string, reply: number): Operation<Boundary, Y> {
            trace.push(`resume:${id}:${reply}`);
            yield* host.wait(Promise.resolve());
            return { kind: "cancelled", reason: "declined" };
          },
          *cancel(): Operation<Boundary, Y> {
            trace.push("cancel");
            yield* host.wait(Promise.resolve());
            return { kind: "suspended", suspensionId: "cleanup", request: "release" };
          },
          *capture() {
            captureStarted.resolve();
            yield* host.wait(captureReleased.promise);
            return { saved: "question" };
          },
          *dispose() {
            yield* host.wait(Promise.resolve());
            trace.push("dispose");
          },
        },
        middleware: [
          {
            *resume(args, next) {
              trace.push("before");
              const result = yield* next(...args);
              trace.push("after");
              return result;
            },
          },
        ],
      });
      const snapshot = host.start(() => state.execution.capture());
      await captureStarted.promise;
      await expect(host.start(() => state.execution.cancel()).result).rejects.toThrow(
        "execution_command_in_progress",
      );
      captureReleased.resolve();
      expect(await snapshot.result).toEqual({ saved: "question" });
      expect(await host.start(() => state.execution.cancel()).result).toEqual({
        kind: "suspended",
        suspensionId: "cleanup",
        request: "release",
      });
      await expect(host.start(() => state.execution.resume("question", 0)).result).rejects.toThrow(
        "execution_suspension_mismatch",
      );
      expect(trace).not.toContain("resume:question:0");
      trace.length = 0;
      expect(await host.start(() => state.execution.resume("cleanup", 1)).result).toEqual({
        kind: "cancelled",
        reason: "declined",
      });
      await host.start(() => state.execution.dispose()).result;
      await host.start(() => state.execution.dispose()).result;
      expect(trace).toEqual(["before", "resume:cleanup:1", "after", "dispose"]);
    });
  });
}
scenarios<EffectionYield>("Effection", {
  start(work) {
    const task = run(work);
    return {
      result: Promise.resolve(task),
      cancel: async () => {
        await task.halt();
      },
    };
  },
  *wait(promise) {
    return yield* call(() => promise);
  },
});
scenarios<EffectYield>("Effect", {
  start(work) {
    const controller = new AbortController();
    const result = Effect.runPromise(effectProgram(work), { signal: controller.signal });
    return {
      result,
      cancel: async () => {
        controller.abort();
        await result.catch(() => undefined);
      },
    };
  },
  wait: (promise) => Effect.promise(() => promise),
});

// Compile-time evidence: result and request types survive the shared cursor factory.
const inferred = createGuest({
  *start() {
    return { kind: "completed" as const, value: { count: 1 } };
  },
  *resume() {
    return { kind: "completed" as const, value: { count: 2 } };
  },
  *close() {},
});
inferred satisfies Guest<{ count: number }, unknown, never>;
type InferredTurn = ReturnType<typeof inferred.start>;
type Assert<T extends true> = T;
export type ResultPreserved = Assert<
  InferredTurn extends Operation<Turn<{ count: number }, unknown>, never> ? true : false
>;
