import { run } from "effection";
import { describe, expect, it } from "vitest";
import { completeChild, completeRoot } from "@sweatpants/durable-execution/transitions";
import type { ExecutionTreeSnapshot, TaskControlState } from "@sweatpants/durable-execution";
import { ExecutionStoreApi, installExecutionStore } from "./api.ts";
import { createMemoryExecutionStore } from "./memory.ts";
import { installStorageMetrics } from "./metrics-middleware.ts";

const program = { id: "program", version: "1", digest: "a".repeat(64) };

function task(
  overrides: Partial<TaskControlState> & Pick<TaskControlState, "taskId">,
): TaskControlState {
  return {
    taskId: overrides.taskId,
    program,
    input: { storage: "inline", value: null },
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

function parkedExecution(executionId: string, turnId: string): ExecutionTreeSnapshot {
  return {
    format: "sweatpants.execution-tree.v1",
    executionId,
    sessionId: "session-1",
    turnId,
    rootTaskId: "root",
    rootProgram: program,
    tasks: [
      task({
        taskId: "root",
        status: "parked",
        pending: { type: "child", pullId: "pull-1", childTaskId: "child" },
      }),
      task({ taskId: "child", parentTaskId: "root", parentPullId: "pull-1" }),
    ],
    runnableTaskIds: [],
    checkpoint: null,
    unpublishedProjection: { throughSequence: 0, facts: null },
  };
}

function* completeTurn(executionId: string, index: number) {
  const snapshot = parkedExecution(executionId, `turn-${index}`);
  yield* ExecutionStoreApi.operations.commitExecution({
    executionId,
    expectedRevision: null,
    next: snapshot,
    privateRecords: [],
  });
  const folded = completeChild(snapshot, {
    childTaskId: "child",
    outcome: { status: "ok", value: index },
  });
  yield* ExecutionStoreApi.operations.appendReplay({
    executionId,
    taskId: "root",
    previous: null,
    entries: folded.replayAppends.map((append) => append.outcome),
  });
  const terminal = completeRoot(folded.next as ExecutionTreeSnapshot, {
    outcome: { storage: "inline", value: `result-${index}` },
    disposition: "completed",
    finalRevision: 1,
    completedAt: index,
  });
  yield* ExecutionStoreApi.operations.commitExecution({
    executionId,
    expectedRevision: 0,
    next: terminal.next,
    privateRecords: [],
  });
}

describe.each([10, 100, 1000])("bounded execution certification at %i completed Turns", (size) => {
  it("resumes one active Turn without reading completed Turn journals", async () => {
    await run(function* () {
      yield* installExecutionStore(createMemoryExecutionStore());
      const recorder = yield* installStorageMetrics();

      for (let index = 0; index < size; index += 1) {
        yield* completeTurn(`completed-${index}`, index);
      }

      const activeId = "active-execution";
      yield* ExecutionStoreApi.operations.commitExecution({
        executionId: activeId,
        expectedRevision: null,
        next: parkedExecution(activeId, "active-turn"),
        privateRecords: [],
      });

      // Catastrophic Host replacement: a fresh Host resumes only active work.
      recorder.reset();
      const resumed = yield* ExecutionStoreApi.operations.loadExecution(activeId);
      expect(resumed).not.toBeNull();
      const decision = completeChild(resumed!.record as ExecutionTreeSnapshot, {
        childTaskId: "child",
        outcome: { status: "ok", value: "resumed" },
      });
      yield* ExecutionStoreApi.operations.appendReplay({
        executionId: activeId,
        taskId: "root",
        previous: null,
        entries: decision.replayAppends.map((append) => append.outcome),
      });
      yield* ExecutionStoreApi.operations.commitExecution({
        executionId: activeId,
        expectedRevision: resumed!.revision,
        next: decision.next,
        privateRecords: [],
      });

      const metrics = recorder.metrics();
      expect(metrics.executionsTouched).toEqual([activeId]);
      expect(metrics.executionReads).toBe(1);
      expect(metrics.executionCommits).toBe(1);
      expect(metrics.replayObjectsRewritten).toBe(0);
      expect(metrics.resumeBytes).toBeLessThan(4096);
      expect(metrics.mutationBytes).toBeLessThan(4096);
    });
  });
});

describe("mandatory storage path without middleware", () => {
  it("commits and rejects stale revisions with no middleware installed", async () => {
    await run(function* () {
      yield* installExecutionStore(createMemoryExecutionStore());
      const snapshot = parkedExecution("execution-1", "turn-1");

      expect(
        yield* ExecutionStoreApi.operations.commitExecution({
          executionId: "execution-1",
          expectedRevision: null,
          next: snapshot,
          privateRecords: [],
        }),
      ).toEqual({ status: "accepted", revision: 0 });
      expect(
        yield* ExecutionStoreApi.operations.commitExecution({
          executionId: "execution-1",
          expectedRevision: null,
          next: snapshot,
          privateRecords: [],
        }),
      ).toEqual({ status: "conflict", actualRevision: 0 });
    });
  });
});
