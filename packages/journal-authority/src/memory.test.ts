import { run } from "effection";
import { describe, expect, it } from "vitest";
import { createMemoryExecutionStore } from "./memory.ts";

const record = {
  format: "sweatpants.execution-tree.v1" as const,
  executionId: "execution-1",
  sessionId: "session-1",
  turnId: "turn-1",
  rootTaskId: "root",
  rootProgram: { id: "program", version: "1", digest: "digest" },
  tasks: [],
  runnableTaskIds: [],
  checkpoint: null,
  unpublishedProjection: { throughSequence: 0, facts: null },
};

describe("memory execution store", () => {
  it("uses per-execution CAS and preserves prior immutable replay objects", async () => {
    const store = createMemoryExecutionStore();
    await run(function* () {
      expect(yield* store.loadExecution("execution-1")).toBeNull();
      expect(
        yield* store.commitExecution({
          executionId: "execution-1",
          expectedRevision: null,
          next: record,
          privateRecords: [],
        }),
      ).toEqual({ status: "accepted", revision: 0 });
      expect(
        yield* store.commitExecution({
          executionId: "execution-1",
          expectedRevision: null,
          next: record,
          privateRecords: [],
        }),
      ).toEqual({ status: "conflict", actualRevision: 0 });

      const first = yield* store.appendReplay({
        executionId: "execution-1",
        taskId: "root",
        previous: null,
        entries: [{ outcome: "first" }],
      });
      const second = yield* store.appendReplay({
        executionId: "execution-1",
        taskId: "root",
        previous: first,
        entries: [{ outcome: "second" }],
      });
      expect(yield* store.readReplay(first)).toEqual([{ outcome: "first" }]);
      expect(yield* store.readReplay(second)).toEqual([
        { outcome: "first" },
        { outcome: "second" },
      ]);
    });
  });
});
