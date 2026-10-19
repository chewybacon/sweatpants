import type { ExecutionDriver, Json } from "@sweatpants/foundation";
import type { KernelRequest, KernelReply, KernelSnapshot } from "../index.ts";
type Driver = ExecutionDriver<KernelRequest, KernelReply, Json, Json> & {
  capture(): import("effection").Operation<KernelSnapshot>;
};
import { expect, it } from "vitest";
import { run, action, spawn, createQueue } from "effection";
import { createKernelExecution, type KernelBoundary } from "../index.ts";

const effect: KernelBoundary = {
  kind: "suspended",
  suspensionId: "1",
  request: { site: "loop", request: null },
};

it("distinguishes repeated sites, rejects stale replies, and resumes cleanup", async () => {
  const replies: unknown[] = [];
  let disposed = 0;
  const kernel: Driver = {
    *turn(command) {
      if (command.kind === "cancel") {
        return {
          kind: "suspended",
          suspensionId: "3",
          request: { site: "cleanup", request: "release" },
        };
      }
      replies.push(command.reply);
      return replies.length === 1 ? { ...effect, suspensionId: "2" } : { kind: "cancelled" };
    },
    *capture() {
      throw new Error("snapshot ownership stays with kernel");
    },
    *dispose() {
      disposed++;
    },
  };
  const { execution, boundary } = createKernelExecution(effect, kernel);
  expect(boundary).toMatchObject({ kind: "suspended", suspensionId: "1" });
  expect(await run(() => execution.resume("1", { kind: "value", value: true }))).toMatchObject({
    kind: "suspended",
    suspensionId: "2",
    request: { site: "loop" },
  });
  await expect(run(() => execution.resume("1", { kind: "value", value: false }))).rejects.toThrow(
    "execution_suspension_mismatch",
  );
  expect(replies).toHaveLength(1);
  expect(await run(() => execution.cancel())).toMatchObject({
    kind: "suspended",
    suspensionId: "3",
    request: { site: "cleanup" },
  });
  expect(await run(() => execution.resume("3", { kind: "value", value: null }))).toEqual({
    kind: "cancelled",
  });
  expect(await run(() => execution.cancel())).toEqual({ kind: "cancelled" });
  await run(() => execution.dispose());
  await run(() => execution.dispose());
  expect(disposed).toBe(1);
});

it("fails closed after an unknown advance outcome but still releases compute", async () => {
  let disposed = false;
  const kernel: Driver = {
    *turn() {
      throw new Error("connection lost");
    },

    *capture() {
      throw new Error("unused");
    },
    *dispose() {
      disposed = true;
    },
  };
  const { execution } = createKernelExecution(effect, kernel);
  await expect(run(() => execution.resume("1", { kind: "value", value: null }))).rejects.toThrow(
    "connection lost",
  );
  await expect(run(() => execution.cancel())).rejects.toThrow("execution_outcome_unknown");
  await run(() => execution.dispose());
  expect(disposed).toBe(true);
});

it("rejects overlapping commands while an advance is in progress", async () => {
  await run(function* () {
    let release!: (value: KernelBoundary) => void;
    const entered = createQueue<void, never>();
    const kernel: Driver = {
      *turn() {
        return yield* action<KernelBoundary>((resolve) => {
          release = resolve;
          entered.add();
          return () => {};
        });
      },

      *capture() {
        throw new Error("unused");
      },
      *dispose() {},
    };
    const { execution } = createKernelExecution(effect, kernel);
    const pending = yield* spawn(() => execution.resume("1", { kind: "value", value: null }));
    yield* entered.next();
    let failure: unknown;
    try {
      yield* execution.cancel();
    } catch (error) {
      failure = error;
    }
    expect(failure).toEqual(new Error("execution_command_in_progress"));
    release({ kind: "completed", value: true });
    expect(yield* pending).toEqual({ kind: "completed", value: true });
    yield* execution.dispose();
  });
});

it("does not send another command after the caller abandons an in-flight resume", async () => {
  await run(function* () {
    const entered = createQueue<void, never>();
    let commands = 0;
    let disposed = false;
    const kernel: Driver = {
      *turn() {
        commands++;
        entered.add();
        return yield* action<KernelBoundary>(() => () => {});
      },

      *capture() {
        throw new Error("unused");
      },
      *dispose() {
        disposed = true;
      },
    };
    const { execution } = createKernelExecution(effect, kernel);
    const advancing = yield* spawn(() => execution.resume("1", { kind: "value", value: null }));
    yield* entered.next();

    yield* advancing.halt();
    let failure: unknown;
    try {
      yield* execution.cancel();
    } catch (error) {
      failure = error;
    }
    expect(failure).toEqual(new Error("execution_outcome_unknown"));
    expect(commands).toBe(1);

    yield* execution.dispose();
    expect(disposed).toBe(true);
  });
});

it("captures on the same shared handle without an executor lookup or forwarding handle", async () => {
  const snapshot = {
    kernel: { kind: "fixture", version: "1", programFormat: "1", snapshotFormat: "1" },
    programDigest: "program",
    state: { waiting: true },
  };
  const events: string[] = [];
  const executionState = createKernelExecution(effect, {
    *turn(command) {
      events.push(command.kind);
      return { kind: "completed", value: true };
    },
    *capture() {
      events.push("capture");
      return snapshot;
    },
    *dispose() {
      events.push("dispose");
    },
  });
  await run(function* () {
    expect(yield* executionState.execution.capture()).toBe(snapshot);
    expect(yield* executionState.execution.resume("1", { kind: "value", value: true })).toEqual({
      kind: "completed",
      value: true,
    });
    yield* executionState.execution.dispose();
  });
  expect(events).toEqual(["capture", "resume", "dispose"]);
});
