import { describe, expect, it } from "vitest";
import { run } from "effection";
import { canonicalDigest } from "@sweatpants/foundation";
import { replayProgramRecovery } from "../program-recovery.ts";
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
      if (checkpoint.kind !== "replay") throw new Error("Expected replay checkpoint");
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
  it("rejects a requested position not reached by the supplied history", async () => {
    const { driver, calls } = fixture();
    await expect(
      run(() => driver.restore({ ...request, replayedThroughActionIndex: 2 })),
    ).rejects.toThrow("requested journal position");
    expect(calls).toEqual(["attach", "start", "shutdown:failed"]);
  });
});
