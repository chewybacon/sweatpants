import { describe, expect, it } from "vitest";
import { run, sleep, spawn, suspend } from "effection";

/**
 * Pins the effection halt/unwind semantics that session and worker teardown
 * rely on. These behaviors are provided by the coroutine unwinding/critical
 * machinery in effection 4.1 (thefrontside/effection#1168); this suite exists
 * so a future effection bump that regresses them fails loudly here instead of
 * as flaky teardown in create-session.ts / transport/worker/host.ts.
 */
describe("effection halt semantics (upstream invariants)", () => {
  it("runs async cleanup in finally to completion during halt", async () => {
    const log: string[] = [];
    await run(function* () {
      const task = yield* spawn(function* () {
        try {
          yield* suspend();
        } finally {
          log.push("finally-enter");
          // Async cleanup while unwinding: must not be abandoned.
          yield* sleep(10);
          log.push("finally-after-sleep");
        }
      });
      yield* sleep(5);
      yield* task.halt();
      log.push("halt-returned");
    });
    expect(log).toEqual(["finally-enter", "finally-after-sleep", "halt-returned"]);
  });

  it("completes a nested `yield* child.halt()` inside a finally during parent unwind", async () => {
    // Shape used by createWorkerPrincipal (core transport/worker/host.ts):
    // the provide() finally halts the request pump while the worker resource
    // itself is being torn down (unwind within unwind).
    const log: string[] = [];
    await run(function* () {
      const outer = yield* spawn(function* () {
        const child = yield* spawn(function* () {
          try {
            yield* suspend();
          } finally {
            log.push("child-finally");
            yield* sleep(10);
            log.push("child-cleanup-done");
          }
        });
        try {
          yield* suspend();
        } finally {
          log.push("outer-finally");
          yield* child.halt();
          log.push("outer-halt-done");
        }
      });
      yield* sleep(5);
      yield* outer.halt();
    });
    expect(log).toEqual([
      "outer-finally",
      "child-finally",
      "child-cleanup-done",
      "outer-halt-done",
    ]);
  });

  it("settles Promise observers of a task halted implicitly by scope teardown", async () => {
    // Shape used by launchRequest (create-session.ts): lifecycle callbacks
    // hang off Promise.resolve(task) and must fire even when the task is
    // halted by parent scope destruction rather than an explicit halt().
    const log: string[] = [];
    await run(function* () {
      const task = yield* spawn(function* () {
        try {
          yield* suspend();
        } finally {
          log.push("task-finally");
        }
      });
      void Promise.resolve(task)
        .catch(() => undefined)
        .finally(() => log.push("promise-finally"));
      yield* sleep(5);
      // Returning destroys the scope, implicitly halting the child task.
    });
    // Promise callbacks land on the microtask queue after run() resolves.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(log).toEqual(["task-finally", "promise-finally"]);
  });

  it("halt() returned future is driven by yield*, sequencing after cleanup", async () => {
    // task.halt() is lazy: it must be consumed (yield*/await) to run. This
    // pins that yield* both drives it and waits for the halted task's finally.
    const log: string[] = [];
    await run(function* () {
      const task = yield* spawn(function* () {
        try {
          yield* suspend();
        } finally {
          yield* sleep(10);
          log.push("cleanup-done");
        }
      });
      yield* sleep(5);
      yield* task.halt();
      log.push("after-halt");
    });
    expect(log).toEqual(["cleanup-done", "after-halt"]);
  });
});
