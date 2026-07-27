import { describe, expect, it } from "vitest";
import type { ExecutionTreeSnapshot, TaskControlState } from "./contract.ts";
import { parseRecoveryCheckpoint, proposeQuiescentCut } from "./checkpoint.ts";

const program = { id: "program", version: "1", digest: "a".repeat(64) };

function task(
  overrides: Partial<TaskControlState> & Pick<TaskControlState, "taskId">,
): TaskControlState {
  // `overrides` already carries taskId and is spread below; naming it twice made
  // the first assignment dead.
  return {
    program,
    input: { storage: "inline", value: null },
    route: {},
    status: "parked",
    actionIndex: 3,
    pullIndex: 1,
    emissionIndex: 0,
    replayHead: { id: "replay-1" },
    pending: { type: "elicit", pullId: "pull-1", descriptor: {} },
    ...overrides,
  };
}

function snapshot(
  tasks: readonly TaskControlState[],
  runnable: string[] = [],
): ExecutionTreeSnapshot {
  return {
    format: "sweatpants.execution-tree.v1",
    executionId: "execution-1",
    sessionId: "session-1",
    turnId: "turn-1",
    rootTaskId: "root",
    rootProgram: program,
    tasks,
    runnableTaskIds: runnable,
    checkpoint: null,
    unpublishedProjection: { throughSequence: 4, facts: { id: "facts-1" } },
  };
}

const fence = {
  executionRevision: 7,
  expectedRevision: 7,
  activationEpoch: 2,
  expectedActivationEpoch: 2,
};

describe("quiescent cut", () => {
  it("captures parked topology, pending inputs, and required child outcomes", () => {
    const decision = proposeQuiescentCut(
      snapshot([
        task({
          taskId: "root",
          pending: { type: "child", pullId: "pull-child", childTaskId: "child" },
        }),
        task({ taskId: "child", parentTaskId: "root", parentPullId: "pull-child" }),
      ]),
      fence,
    );

    expect(decision.status).toBe("checkpointed");
    if (decision.status !== "checkpointed") {
      return;
    }
    expect(decision.checkpoint).toMatchObject({
      format: "sweatpants.recovery-checkpoint.v1",
      executionRevision: 7,
      activationEpoch: 2,
      rootTaskId: "root",
      pendingInputs: [{ taskId: "child", pullId: "pull-1" }],
      requiredOutcomes: [{ parentTaskId: "root", childTaskId: "child", pullId: "pull-child" }],
      projection: { throughSequence: 4, facts: { id: "facts-1" } },
    });
    expect(decision.checkpoint.tasks.map((entry) => entry.replayHead)).toEqual([
      { id: "replay-1" },
      { id: "replay-1" },
    ]);
  });

  it("rejects runnable work, unparked tasks, and stale fences", () => {
    expect(proposeQuiescentCut(snapshot([task({ taskId: "root" })], ["root"]), fence)).toEqual({
      status: "rejected",
      code: "not_quiescent",
    });
    expect(
      proposeQuiescentCut(snapshot([task({ taskId: "root", status: "active" })]), fence),
    ).toEqual({ status: "rejected", code: "not_quiescent" });
    expect(
      proposeQuiescentCut(snapshot([task({ taskId: "root" })]), { ...fence, expectedRevision: 6 }),
    ).toEqual({ status: "rejected", code: "stale_revision" });
    expect(
      proposeQuiescentCut(snapshot([task({ taskId: "root" })]), {
        ...fence,
        expectedActivationEpoch: 9,
      }),
    ).toEqual({ status: "rejected", code: "stale_activation" });
  });

  it("rejects a cut while a Host-owned effect is still in flight", () => {
    expect(
      proposeQuiescentCut(
        snapshot([
          task({
            taskId: "root",
            pending: { type: "effect", pullId: "pull-1", attemptId: "a1", hostOwned: true },
          }),
        ]),
        fence,
      ),
    ).toEqual({ status: "rejected", code: "host_effect_in_flight" });
  });

  it("accepts a parked non-Host effect boundary", () => {
    const decision = proposeQuiescentCut(
      snapshot([
        task({
          taskId: "root",
          pending: { type: "effect", pullId: "pull-1", attemptId: "a1", hostOwned: false },
        }),
      ]),
      fence,
    );
    expect(decision.status).toBe("checkpointed");
  });

  it("rejects checkpoints missing a required category", () => {
    const decision = proposeQuiescentCut(snapshot([task({ taskId: "root" })]), fence);
    if (decision.status !== "checkpointed") {
      throw new Error("expected a checkpoint");
    }
    expect(parseRecoveryCheckpoint(decision.checkpoint)).toEqual(decision.checkpoint);

    const { tasks: _tasks, ...missingTopology } = decision.checkpoint;
    expect(() => parseRecoveryCheckpoint(missingTopology)).toThrow(/categories are incomplete/);
    expect(() => parseRecoveryCheckpoint({ ...decision.checkpoint, tasks: [] })).toThrow(
      /parked topology/,
    );
    expect(() =>
      parseRecoveryCheckpoint({ ...decision.checkpoint, executionRevision: 1.5 }),
    ).toThrow(/field value is invalid/);
  });
});
