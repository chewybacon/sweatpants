import { describe, expect, it } from "vitest";
import { run } from "effection";
import { canonicalDigest } from "@sweatpants/foundation";
import {
  replayProgramRecovery,
  assertProgramReplayFrontier,
  verifyProgramReplayEntry,
} from "../program-recovery.ts";
import {
  REPLAY_CHECKPOINT_CAPABILITIES,
  type ProgramDriver,
  type ProgramRestoreRequest,
  type ReplayEmissionEntry,
} from "../program-driver-contract.ts";

const attach = {
  sessionId: "session",
  taskId: "task",
  executionEpoch: 1,
  program: { id: "example", version: "1", digest: "program" },
  input: null,
  route: { driverKind: "program" },
};
const request: ProgramRestoreRequest = {
  attach,
  checkpoint: { kind: "replay" },
  replay: [],
  replayChainSeed: "seed",
  replayChainDigest: "seed",
  replayedThroughActionIndex: -1,
};
const descriptor = { eventType: "progress", payload: "hello" };
function fixture() {
  const calls: string[] = [];
  const driver: ProgramDriver = {
    ...replayProgramRecovery,
    evaluatorKind: "program",
    capabilities: REPLAY_CHECKPOINT_CAPABILITIES,
    *attach() {
      calls.push("attach");
      return {
        attachmentId: "attachment",
        taskId: "task",
        driverKind: "program",
        route: attach.route,
        executionEpoch: 1,
        handle: null,
      };
    },
    *step(_attachment, command) {
      calls.push(command.type);
      if (command.type === "start") {
        return { type: "emission", actionIndex: 0, descriptor };
      }
      return { type: "completed", actionIndex: 1, value: "done" };
    },
    *shutdown(_attachment, reason) {
      calls.push(`shutdown:${reason}`);
    },
  };
  return { driver, calls };
}
function entry(): ReplayEmissionEntry {
  const body = {
    type: "emission" as const,
    actionIndex: 0,
    descriptorKind: "emission",
    descriptorDigest: canonicalDigest(descriptor),
    previousEntryDigest: "seed",
    offset: "offset",
  };
  return {
    ...body,
    entryDigest: canonicalDigest({
      replayChainSeed: "seed",
      previousEntryDigest: "seed",
      entryWithoutEntryDigest: body,
    }),
  };
}

describe("required program recovery contract", () => {
  it("captures a replay marker without stepping or destroying compute", async () => {
    const { driver, calls } = fixture();
    await run(function* () {
      const attachment = yield* driver.attach(attach);
      const checkpoint = yield* driver.checkpoint(attachment);
      expect(checkpoint).toEqual({ kind: "replay" });
      if (checkpoint.kind !== "replay") {
        throw new Error("Expected replay checkpoint");
      }
      expect(calls).toEqual(["attach"]);
      yield* driver.shutdown(attachment, "parked");
      const restored = yield* driver.restore({ ...request, checkpoint });
      expect(restored.frontier).toEqual({ type: "emission", actionIndex: 0, descriptor });
      expect(calls).toEqual(["attach", "shutdown:parked", "attach", "start"]);
    });
  });
  it("replays an accepted emission through the ordinary step contract", async () => {
    const { driver, calls } = fixture();
    const recorded = entry();
    const restored = await run(() =>
      driver.restore({
        ...request,
        replay: [recorded],
        replayedThroughActionIndex: 0,
        replayChainDigest: recorded.entryDigest,
      }),
    );
    expect(restored.frontier).toEqual({ type: "completed", actionIndex: 1, value: "done" });
    expect(calls).toEqual(["attach", "start", "ack_emission"]);
  });
  it("supports asynchronous replay streams", async () => {
    const { driver } = fixture();
    const recorded = entry();
    const restored = await run(() =>
      driver.restore({
        ...request,
        replay: {
          async *[Symbol.asyncIterator]() {
            yield recorded;
          },
        },
        replayedThroughActionIndex: 0,
        replayChainDigest: recorded.entryDigest,
      }),
    );
    expect(restored.replayedThroughActionIndex).toBe(0);
  });
  it("rejects unsupported continuations before allocating compute", async () => {
    const { driver, calls } = fixture();
    await expect(
      run(() =>
        driver.restore({
          ...request,
          checkpoint: {
            kind: "continuation",
            format: "other",
            resumeAfter: { actionIndex: -1, replayChainDigest: "seed" },
            programDigest: "program",
            state: null,
          },
        }),
      ),
    ).rejects.toThrow("cannot restore a continuation");
    expect(calls).toEqual([]);
  });
  it("releases compute and closes the replay iterator on corrupt history", async () => {
    const { driver, calls } = fixture();
    let closed = false;
    const replay = {
      *[Symbol.iterator]() {
        try {
          yield { ...entry(), entryDigest: "corrupt" };
        } finally {
          closed = true;
        }
      },
    };
    await expect(run(() => driver.restore({ ...request, replay }))).rejects.toThrow(
      "Replay entry digest differs",
    );
    expect(closed).toBe(true);
    expect(calls).toEqual(["attach", "start", "shutdown:failed"]);
  });
  it("awaits asynchronous iterator cleanup and preserves its receiver on corrupt history", async () => {
    const { driver, calls } = fixture();
    let closed = false;
    const iterator = {
      async next() {
        return { done: false as const, value: { ...entry(), entryDigest: "corrupt" } };
      },
      async return() {
        expect(this).toBe(iterator);
        await Promise.resolve();
        closed = true;
        return { done: true as const, value: undefined };
      },
    };
    const replay = { [Symbol.asyncIterator]: () => iterator };
    await expect(run(() => driver.restore({ ...request, replay }))).rejects.toThrow(
      "Replay entry digest differs",
    );
    expect(closed).toBe(true);
    expect(calls).toEqual(["attach", "start", "shutdown:failed"]);
  });
  it("closes a rejected asynchronous source and releases its attachment", async () => {
    const { driver, calls } = fixture();
    let closed = false;
    const replay = {
      [Symbol.asyncIterator]() {
        return {
          next: () => Promise.reject(new Error("source unavailable")),
          async return() {
            closed = true;
            return { done: true as const, value: undefined };
          },
        };
      },
    };
    await expect(run(() => driver.restore({ ...request, replay }))).rejects.toMatchObject({
      code: "replay_diverged",
      details: { cause: "source unavailable" },
    });
    expect(closed).toBe(true);
    expect(calls).toEqual(["attach", "start", "shutdown:failed"]);
  });
  it("rejects a requested position not reached by the supplied history", async () => {
    const { driver, calls } = fixture();
    await expect(
      run(() => driver.restore({ ...request, replayedThroughActionIndex: 2 })),
    ).rejects.toThrow("requested journal position");
    expect(calls).toEqual(["attach", "start", "shutdown:failed"]);
  });
});

it("compares live optional fields with persisted replay identities", async () => {
  const storedDescriptor = { kind: "wait" as const, key: "pause" };
  const storedOutcome = {
    status: "error" as const,
    error: { code: "failed", message: "Original" },
  };
  const body = {
    type: "operation" as const,
    actionIndex: 0,
    descriptorKind: "wait",
    descriptorDigest: canonicalDigest(storedDescriptor),
    previousEntryDigest: "seed",
    outcome: storedOutcome,
    receipt: {
      sessionId: "session",
      taskId: "task",
      pullId: "pull",
      resolutionOffset: "0",
      outcomeDigest: canonicalDigest(storedOutcome),
      status: "accepted" as const,
    },
  };
  const accepted = {
    ...body,
    outcome: { ...storedOutcome, error: { ...storedOutcome.error, details: undefined } },
    entryDigest: canonicalDigest({
      replayChainSeed: "seed",
      previousEntryDigest: "seed",
      entryWithoutEntryDigest: body,
    }),
  };
  const frontier = {
    type: "operation" as const,
    actionIndex: 0,
    descriptor: { ...storedDescriptor, notBefore: undefined, durationMs: undefined },
  };
  expect(() => verifyProgramReplayEntry("seed", accepted, "seed")).not.toThrow();
  expect(() => assertProgramReplayFrontier(frontier, accepted)).not.toThrow();
  expect(() =>
    assertProgramReplayFrontier(
      { ...frontier, descriptor: { ...frontier.descriptor, durationMs: 1 } },
      accepted,
    ),
  ).toThrow("Evaluator operation differs");
  expect(() =>
    verifyProgramReplayEntry(
      "seed",
      { ...accepted, outcome: { status: "error", error: { code: "failed", message: "Changed" } } },
      "seed",
    ),
  ).toThrow("Replay entry digest differs");
  await run(function* () {
    const { driver } = fixture();
    driver.step = function* () {
      return frontier;
    };
    const restored = yield* driver.restore(request);
    expect(restored.frontierDigest).toBe(
      canonicalDigest({ type: "operation", actionIndex: 0, descriptor: storedDescriptor }),
    );
  });
});
