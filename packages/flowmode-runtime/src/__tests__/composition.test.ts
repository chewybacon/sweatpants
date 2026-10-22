import { expect, it } from "vitest";
import { run } from "effection";
import { createKernelExecution, createWorkflowRuntime, type WorkflowBoundary } from "../index.ts";

it("execution middleware preserves one suspension guard, cleanup and failure propagation", async () => {
  const identity = { kind: "fixture", version: "1", programFormat: "1", snapshotFormat: "1" };
  const program = { digest: "program", kernel: identity, code: null };
  const initial: WorkflowBoundary = {
    kind: "suspended",
    suspensionId: "approval",
    request: { site: "approval", binding: "ask", input: null },
  };
  const trace: string[] = [];
  let turns = 0;
  const captureFailure = new Error("capture unavailable");
  const runtime = createWorkflowRuntime({
    driver: {
      kernelIdentity: identity,
      *createKernel() {
        return {
          identity,
          *start() {
            return createKernelExecution({
              initial,
              driver: {
                *turn(command) {
                  turns++;
                  return command.kind === "cancel"
                    ? {
                        kind: "suspended",
                        suspensionId: "cleanup",
                        request: { site: "cleanup", binding: "release", input: null },
                      }
                    : { kind: "cancelled" };
                },
                *capture() {
                  throw captureFailure;
                },
                *dispose() {
                  trace.push("disposed");
                },
              },
            });
          },
          *restore() {
            throw Error("No restore in this scenario");
          },
          *close() {},
        };
      },
    },
    executionMiddleware: [
      {
        *cancel(args, next) {
          trace.push("outer:before");
          const boundary = yield* next(...args);
          trace.push("outer:after");
          return boundary;
        },
        *capture(args, next) {
          try {
            return yield* next(...args);
          } finally {
            trace.push("capture:finally");
          }
        },
      },
      {
        *cancel(args, next) {
          trace.push("inner:before");
          const boundary = yield* next(...args);
          trace.push("inner:after");
          return boundary;
        },
      },
    ],
  });
  await run(function* () {
    const kernel = yield* runtime.createKernel();
    const state = yield* kernel.start(program, null);
    const cleanup = yield* state.execution.cancel();
    expect(cleanup).toMatchObject({ kind: "suspended", suspensionId: "cleanup" });
    expect(trace).toEqual(["outer:before", "inner:before", "inner:after", "outer:after"]);
    try {
      yield* state.execution.resume("approval", { kind: "value", value: null });
      expect.unreachable("stale reply must fail");
    } catch (error) {
      expect(error).toMatchObject({ message: "execution_suspension_mismatch" });
    }
    expect(turns).toBe(1);
    try {
      yield* state.execution.capture();
      expect.unreachable("capture must fail");
    } catch (error) {
      expect(error).toBe(captureFailure);
    }
    expect(trace).toContain("capture:finally");
    expect(yield* state.execution.resume("cleanup", { kind: "value", value: null })).toEqual({
      kind: "cancelled",
    });
    yield* state.execution.dispose();
    yield* state.execution.dispose();
    expect(trace.filter((event) => event === "disposed")).toHaveLength(1);
    yield* kernel.close();
  });
});
