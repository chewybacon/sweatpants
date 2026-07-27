import { run } from "effection";
import { describe, expect, it } from "vitest";
import { createMemoryExecutionStore } from "@sweatpants/journal-authority/memory";
import { completeChild, completeRoot } from "@sweatpants/durable-execution/transitions";
import type { ExecutionTreeSnapshot, TaskControlState } from "@sweatpants/durable-execution";

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
    status: "active",
    actionIndex: 0,
    pullIndex: 0,
    emissionIndex: 0,
    replayHead: null,
    pending: null,
    ...overrides,
  };
}

const parked: ExecutionTreeSnapshot = {
  format: "sweatpants.execution-tree.v1",
  executionId: "execution-1",
  sessionId: "session-1",
  turnId: "turn-1",
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

/**
 * The authority commit loop: evaluate the shared pure transition, persist new
 * immutable replay material, then CAS the bounded control record. The adapter
 * never decides transition validity.
 */
describe("authority commit loop over pure transitions", () => {
  it("commits atomic child folding and unrelated executions stay untouched", async () => {
    const store = createMemoryExecutionStore();
    await run(function* () {
      yield* store.commitExecution({
        executionId: "execution-1",
        expectedRevision: null,
        next: parked,
        privateRecords: [],
      });
      yield* store.commitExecution({
        executionId: "execution-2",
        expectedRevision: null,
        next: { ...parked, executionId: "execution-2" },
        privateRecords: [],
      });

      const loaded = yield* store.loadExecution("execution-1");
      const decision = completeChild(loaded!.record as ExecutionTreeSnapshot, {
        childTaskId: "child",
        outcome: { status: "ok", value: "child-result" },
      });
      const replayHead = yield* store.appendReplay({
        executionId: "execution-1",
        taskId: "root",
        previous: null,
        entries: decision.replayAppends.map((append) => append.outcome),
      });
      const commit = yield* store.commitExecution({
        executionId: "execution-1",
        expectedRevision: loaded!.revision,
        next: decision.next,
        privateRecords: decision.privateRecords,
      });

      expect(commit).toEqual({ status: "accepted", revision: 1 });
      expect(yield* store.readReplay(replayHead)).toEqual([
        { status: "ok", value: "child-result" },
      ]);
      const committed = yield* store.loadExecution("execution-1");
      expect((committed!.record as ExecutionTreeSnapshot).runnableTaskIds).toEqual(["root"]);
      expect(yield* store.loadExecution("execution-2")).toMatchObject({ revision: 0 });
    });
  });

  it("rejects a stale-revision commit without applying the decision", async () => {
    const store = createMemoryExecutionStore();
    await run(function* () {
      yield* store.commitExecution({
        executionId: "execution-1",
        expectedRevision: null,
        next: parked,
        privateRecords: [],
      });
      const stale = yield* store.loadExecution("execution-1");

      const folded = completeChild(stale!.record as ExecutionTreeSnapshot, {
        childTaskId: "child",
        outcome: { status: "ok", value: "winner" },
      });
      yield* store.commitExecution({
        executionId: "execution-1",
        expectedRevision: stale!.revision,
        next: folded.next,
        privateRecords: [],
      });

      const terminal = completeRoot(folded.next as ExecutionTreeSnapshot, {
        outcome: { storage: "inline", value: "terminal" },
        disposition: "completed",
        finalRevision: 1,
        completedAt: 10,
      });
      const conflicted = yield* store.commitExecution({
        executionId: "execution-1",
        expectedRevision: stale!.revision,
        next: terminal.next,
        privateRecords: [],
      });

      expect(conflicted).toEqual({ status: "conflict", actualRevision: 1 });
      expect((yield* store.loadExecution("execution-1"))!.record).toMatchObject({
        format: "sweatpants.execution-tree.v1",
      });
    });
  });
});
