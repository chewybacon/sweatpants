import { describe, expect, it } from "vitest";
import type { ExecutionTreeSnapshot, TaskControlState } from "./contract.ts";
import { completeChild, completeRoot, parseTerminalCapsule } from "./transitions.ts";

const program = { id: "program", version: "1", digest: "a".repeat(64) };
const inline = { storage: "inline" as const, value: null };

function task(
  overrides: Partial<TaskControlState> & Pick<TaskControlState, "taskId">,
): TaskControlState {
  return {
    taskId: overrides.taskId,
    program,
    input: inline,
    route: {},
    status: "active",
    actionIndex: 0,
    pullIndex: 0,
    emissionIndex: 0,
    replayHead: null,
    pending: null,
    ...overrides,
  };
}

function snapshot(tasks: readonly TaskControlState[]): ExecutionTreeSnapshot {
  return {
    format: "sweatpants.execution-tree.v1",
    executionId: "execution-1",
    sessionId: "session-1",
    turnId: "turn-1",
    rootTaskId: "root",
    rootProgram: program,
    tasks,
    runnableTaskIds: [],
    checkpoint: null,
    unpublishedProjection: { throughSequence: 2, facts: { id: "facts-1" } },
  };
}

describe("pure durable execution transitions", () => {
  it("atomically folds a child outcome and makes the parent runnable", () => {
    const current = snapshot([
      task({
        taskId: "root",
        status: "parked",
        pending: { type: "child", pullId: "pull-1", childTaskId: "child" },
      }),
      task({ taskId: "child", parentTaskId: "root", parentPullId: "pull-1" }),
    ]);

    const decision = completeChild(current, {
      childTaskId: "child",
      outcome: { status: "ok", value: { answer: 42 } },
    });

    expect(decision.next).toMatchObject({
      runnableTaskIds: ["root"],
      tasks: [{ taskId: "root", status: "active", pending: null, pullIndex: 1 }],
    });
    expect(decision.replayAppends).toEqual([
      {
        taskId: "root",
        pullId: "pull-1",
        childTaskId: "child",
        outcome: { status: "ok", value: { answer: 42 } },
      },
    ]);
    expect(current.tasks).toHaveLength(2);
  });

  it("rejects child folding without exposing partial state", () => {
    const current = snapshot([
      task({ taskId: "root", status: "parked" }),
      task({ taskId: "child", parentTaskId: "root", parentPullId: "pull-1" }),
    ]);

    expect(() =>
      completeChild(current, { childTaskId: "child", outcome: { status: "ok", value: null } }),
    ).toThrow(/Parent is not waiting/);
    expect(current.tasks).toHaveLength(2);
  });

  it("folds a root to a bounded unpublished Terminal Capsule", () => {
    const current = snapshot([task({ taskId: "root" })]);
    const decision = completeRoot(current, {
      outcome: { storage: "reference", reference: { id: "outcome-1", byteLength: 1024 } },
      disposition: "completed",
      finalRevision: 9,
      completedAt: 1234,
    });

    expect(decision.next).toEqual({
      type: "terminal",
      format: "sweatpants.terminal-execution.v1",
      executionId: "execution-1",
      sessionId: "session-1",
      turnId: "turn-1",
      rootTaskId: "root",
      rootProgram: program,
      outcome: { storage: "reference", reference: { id: "outcome-1", byteLength: 1024 } },
      disposition: "completed",
      finalRevision: 9,
      completedAt: 1234,
      projection: { throughSequence: 2, facts: { id: "facts-1" } },
      publication: "unpublished",
    });
    expect(JSON.stringify(decision.next)).not.toContain("tasks");
    expect(JSON.stringify(decision.next)).not.toContain("replayHead");
  });

  it("strictly rejects incomplete or expanded Terminal Capsules", () => {
    const valid = completeRoot(snapshot([task({ taskId: "root" })]), {
      outcome: inline,
      disposition: "completed",
      finalRevision: 1,
      completedAt: 2,
    }).next;
    expect(parseTerminalCapsule(valid)).toEqual(valid);
    expect(() => parseTerminalCapsule({ ...valid, finalRevision: -1 })).toThrow();
    expect(() => parseTerminalCapsule({ ...valid, tasks: [] })).toThrow();
    const { outcome: _outcome, ...missingOutcome } = valid;
    expect(() => parseTerminalCapsule(missingOutcome)).toThrow();
  });
});
