import { run } from "effection";
import { describe, expect, it } from "vitest";
import { completeChild, completeRoot } from "@sweatpants/durable-execution/transitions";
import type { ExecutionTreeSnapshot, TaskControlState } from "@sweatpants/durable-execution";
import { createMemoryExecutionStore } from "./memory.ts";
import { instrumentExecutionStore } from "./instrumentation.ts";

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

describe.each([10, 100, 1000])("bounded execution certification at %i completed Turns", (size) => {
  it("resumes one active Turn without reading completed Turn journals", async () => {
    const store = instrumentExecutionStore(createMemoryExecutionStore());
    await run(function* () {
      for (let index = 0; index < size; index += 1) {
        const executionId = `completed-${index}`;
        const snapshot = parkedExecution(executionId, `turn-${index}`);
        yield* store.commitExecution({
          executionId,
          expectedRevision: null,
          next: snapshot,
          privateRecords: [],
        });
        const folded = completeChild(snapshot, {
          childTaskId: "child",
          outcome: { status: "ok", value: index },
        });
        yield* store.appendReplay({
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
        yield* store.commitExecution({
          executionId,
          expectedRevision: 0,
          next: terminal.next,
          privateRecords: [],
        });
      }

      const activeId = "active-execution";
      yield* store.commitExecution({
        executionId: activeId,
        expectedRevision: null,
        next: parkedExecution(activeId, "active-turn"),
        privateRecords: [],
      });

      // Catastrophic Host replacement: a fresh Host resumes only active work.
      store.reset();
      const resumed = yield* store.loadExecution(activeId);
      expect(resumed).not.toBeNull();
      const decision = completeChild(resumed!.record as ExecutionTreeSnapshot, {
        childTaskId: "child",
        outcome: { status: "ok", value: "resumed" },
      });
      yield* store.appendReplay({
        executionId: activeId,
        taskId: "root",
        previous: null,
        entries: decision.replayAppends.map((append) => append.outcome),
      });
      yield* store.commitExecution({
        executionId: activeId,
        expectedRevision: resumed!.revision,
        next: decision.next,
        privateRecords: [],
      });

      const metrics = store.metrics();
      expect(metrics.executionsTouched).toEqual([activeId]);
      expect(metrics.executionReads).toBe(1);
      expect(metrics.executionCommits).toBe(1);
      expect(metrics.replayObjectsRewritten).toBe(0);
      expect(metrics.resumeBytes).toBeLessThan(4096);
      expect(metrics.mutationBytes).toBeLessThan(4096);
    });
  });
});
