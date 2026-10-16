import { describe, expect, it } from "vitest";
import { run, scoped, spawn, suspend, withResolvers } from "effection";
import { canonicalDigest } from "@sweatpants/foundation";
import { ProgramDriverRegistryContext } from "../program-driver-context.ts";
import { replayProgramRecovery } from "../program-recovery.ts";
import {
  ProgramRecovery,
  recoverProgram,
  installProgramCheckpointAcceleration,
  type ProgramRecoveryRequest,
} from "../program-recovery-policy.ts";
import { REPLAY_CHECKPOINT_CAPABILITIES, type ProgramDriver } from "../program-driver-contract.ts";

const request: ProgramRecoveryRequest = {
  attach: {
    sessionId: "session",
    taskId: "task",
    executionEpoch: 1,
    program: { id: "test", version: "1", digest: "program" },
    input: null,
    route: { driverKind: "test" },
  },
  checkpoint: {
    kind: "continuation",
    format: "test-v1",
    programDigest: "program",
    state: null,
    resumeAfter: { actionIndex: -1, replayChainDigest: "seed" },
  },
  replay: [],
  replayChainSeed: "seed",
  replayChainDigest: "seed",
  replayedThroughActionIndex: -1,
};
const acceleration = { driverKind: "test", format: "test-v1" };
function fixture() {
  const calls: string[] = [];
  const frontier = { type: "completed" as const, actionIndex: 0, value: "done" };
  const attachment = {
    attachmentId: "attachment",
    taskId: "task",
    driverKind: "test",
    route: request.attach.route,
    executionEpoch: 1,
    handle: null,
  };
  const driver: ProgramDriver = {
    evaluatorKind: "program",
    capabilities: REPLAY_CHECKPOINT_CAPABILITIES,
    *attach() {
      calls.push("attach");
      return attachment;
    },
    *step() {
      calls.push("step");
      return frontier;
    },
    *shutdown(_attachment, reason) {
      calls.push(reason);
    },
    *checkpoint() {
      calls.push("checkpoint");
      return { kind: "replay" };
    },
    *restore(input) {
      calls.push(input.checkpoint.kind);
      if (input.checkpoint.kind === "replay") {
        return yield* replayProgramRecovery.restore.call(this, input);
      }
      return {
        attachment,
        frontier,
        frontierDigest: canonicalDigest(frontier),
        replayChainDigest: "seed",
        replayedThroughActionIndex: -1,
      };
    },
  };
  return { calls, driver, attachment };
}

describe("scoped program recovery policy", () => {
  it("defaults to replay even when the plan offers a continuation", async () => {
    const { calls, driver, attachment } = fixture();
    await run(function* () {
      yield* ProgramDriverRegistryContext.set(new Map([["test", driver]]));
      expect(yield* ProgramRecovery.operations.checkpoint(attachment)).toEqual({ kind: "replay" });
      yield* recoverProgram(request);
    });
    expect(calls).toEqual(["replay", "attach", "step"]);
  });

  it("inherits acceleration in children without affecting siblings or the parent", async () => {
    const { calls, driver } = fixture();
    await run(function* () {
      yield* ProgramDriverRegistryContext.set(new Map([["test", driver]]));
      const accelerated = yield* spawn(function* () {
        yield* installProgramCheckpointAcceleration(acceleration);
        yield* scoped(() => recoverProgram(request));
      });
      const ordinary = yield* spawn(() => recoverProgram(request));
      yield* accelerated;
      yield* ordinary;
      yield* recoverProgram(request);
    });
    expect(calls.filter((call) => call === "continuation")).toHaveLength(1);
    expect(calls.filter((call) => call === "replay")).toHaveLength(2);
  });

  it.each([true, false])(
    "outer policy can disable acceleration, installed first=%s",
    async (first) => {
      const { calls, driver } = fixture();
      const observed: string[] = [];
      await run(function* () {
        yield* ProgramDriverRegistryContext.set(new Map([["test", driver]]));
        if (first) {
          yield* installProgramCheckpointAcceleration(acceleration);
        }
        yield* ProgramRecovery.around({
          *recover([input], next) {
            observed.push("before");
            const result = yield* next({ ...input, checkpoint: { kind: "replay" } });
            observed.push("after");
            return result;
          },
        });
        if (!first) {
          yield* installProgramCheckpointAcceleration(acceleration);
        }
        yield* recoverProgram(request);
      });
      expect(observed).toEqual(["before", "after"]);
      expect(calls).toEqual(["replay", "attach", "step"]);
    },
  );

  it("delegates unknown formats before touching compute", async () => {
    const { calls, driver } = fixture();
    await run(function* () {
      yield* ProgramDriverRegistryContext.set(new Map([["test", driver]]));
      yield* installProgramCheckpointAcceleration({ ...acceleration, format: "other" });
      yield* recoverProgram(request);
    });
    expect(calls).toEqual(["replay", "attach", "step"]);
  });

  it("rejects invalid evidence before middleware can override recovery", async () => {
    let called = false;
    await expect(
      run(function* () {
        yield* ProgramRecovery.around({
          *recover() {
            called = true;
            throw Error("unreachable");
          },
        });
        yield* recoverProgram({ ...request, replayChainDigest: "wrong" });
      }),
    ).rejects.toThrow("Recovery history differs");
    expect(called).toBe(false);
  });

  it("does not replay when an accelerated restore fails", async () => {
    const { calls, driver } = fixture();
    driver.restore = function* () {
      calls.push("restore");
      throw Error("corrupt snapshot");
    };
    await expect(
      run(function* () {
        yield* ProgramDriverRegistryContext.set(new Map([["test", driver]]));
        yield* installProgramCheckpointAcceleration(acceleration);
        yield* recoverProgram(request);
      }),
    ).rejects.toThrow("corrupt snapshot");
    expect(calls).toEqual(["restore"]);
  });

  it("unwinds backend cleanup when cancelled during restoration", async () => {
    const { calls, driver } = fixture();
    await run(function* () {
      const acquired = withResolvers<void>();
      driver.restore = function* () {
        try {
          calls.push("acquire");
          acquired.resolve();
          yield* suspend();
          throw Error("Cancelled restoration unexpectedly resumed");
        } finally {
          calls.push("release");
        }
      };
      const task = yield* spawn(function* () {
        yield* ProgramDriverRegistryContext.set(new Map([["test", driver]]));
        yield* installProgramCheckpointAcceleration(acceleration);
        yield* recoverProgram(request);
      });
      yield* acquired.operation;
      yield* task.halt();
    });
    expect(calls).toEqual(["acquire", "release"]);
  });
});
