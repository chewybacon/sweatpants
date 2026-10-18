import type { Json } from "@sweatpants/foundation";
import { describe, expect, it } from "vitest";
import { run, scoped } from "effection";
import {
  Executor,
  createExecutor,
  createLocalTransport,
  createWorkerTransport,
} from "./fixtures/executor-transport.ts";
import { createQuestionKernel } from "./fixtures/question-kernel.ts";

describe.each(["local", "worker"] as const)("executor composition: %s", (placement) => {
  function transport() {
    return placement === "local"
      ? createLocalTransport(createQuestionKernel)
      : createWorkerTransport(new URL("./fixtures/executor-worker-bootstrap.mjs", import.meta.url));
  }

  it("runs the same program through the same scoped executor and answers two requests", async () => {
    await run(function* () {
      const observed: unknown[] = [];
      yield* Executor.api.around({
        *start([program, input], next) {
          observed.push(program);
          return yield* next(program, input);
        },
      });
      yield* Executor.installDriver(createExecutor(transport()));
      yield* scoped(function* () {
        const executor = yield* Executor.context.expect();
        const program: Json[] = [{ elicit: "Approve?" }, { sample: "Summarize the approval" }];
        const { execution, boundary } = yield* executor.start(program, "booking");
        try {
          expect(boundary).toEqual({ kind: "suspended", suspensionId: "0", request: program[0] });
          const summary = yield* execution.resume("0", true);
          expect(summary).toEqual({ kind: "suspended", suspensionId: "1", request: program[1] });
          const result = yield* execution.resume("1", "Approved.");
          expect(result).toEqual({
            kind: "completed",
            value: { input: "booking", answers: [true, "Approved."] },
          });
          expect(observed).toEqual([program]);
        } finally {
          yield* execution.dispose();
        }
      });
    });
  });

  it("answers cleanup before cancellation becomes terminal", async () => {
    await run(function* () {
      yield* Executor.installDriver(createExecutor(transport()));
      const executor = yield* Executor.use();
      const { execution } = yield* executor.start([{ elicit: "Approve?" }], "booking");
      try {
        const cleanup = yield* execution.cancel();
        expect(cleanup).toEqual({
          kind: "suspended",
          suspensionId: "cleanup",
          request: { release: "booking" },
        });
        const cancelled = yield* execution.resume("cleanup", null);
        expect(cancelled).toEqual({ kind: "cancelled" });
      } finally {
        yield* execution.dispose();
      }
    });
  });

  it("rejects a stale reply and closes the execution explicitly", async () => {
    await run(function* () {
      yield* Executor.installDriver(createExecutor(transport()));
      const executor = yield* Executor.use();
      const { execution } = yield* executor.start(["first", "second"], null);
      yield* execution.resume("0", "one");
      let rejected: unknown;
      try {
        yield* execution.resume("0", "duplicate");
      } catch (error) {
        rejected = error;
      }
      expect(rejected).toEqual(new Error("execution_suspension_mismatch"));
      const completed = yield* execution.resume("1", "two");
      expect(completed).toEqual({
        kind: "completed",
        value: { input: null, answers: ["one", "two"] },
      });
      yield* execution.dispose();
      yield* execution.dispose();
      let closed: unknown;
      try {
        yield* execution.cancel();
      } catch (error) {
        closed = error;
      }
      expect(closed).toEqual(new Error("execution_closed"));
    });
  });
});
