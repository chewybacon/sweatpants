import { run } from "effection";
import { describe, expect, it } from "vitest";
import { createMemoryExecutionStore } from "./memory.ts";
import { runExecutionCommitLoop } from "./commit-loop.ts";

describe("direct execution control commit loop", () => {
  it("commits one bounded control transition", async () => {
    const store = createMemoryExecutionStore();
    await run(function* () {
      const result = yield* runExecutionCommitLoop(store, "execution-1", function* (current) {
        expect(current).toBeNull();
        return {
          status: "commit",
          next: {
            executionId: "execution-1",
            ownerFence: "0",
            status: "active",
            rootTaskId: "root",
            stopGeneration: "0",
            requestedDisposition: null,
            control: { state: "active" },
          },
          result: "opened",
        } as const;
      });
      expect(result).toBe("opened");
      expect((yield* store.loadControl("execution-1"))?.controlRevision).toBe("0");
    });
  });

  it("does not apply a stale owner transition", async () => {
    const store = createMemoryExecutionStore();
    await run(function* () {
      yield* store.commitExecution({
        executionId: "execution-1",
        expectedControlRevision: null,
        expectedOwnerFence: "0",
        nextControl: {
          executionId: "execution-1",
          ownerFence: "2",
          status: "active",
          rootTaskId: "root",
          stopGeneration: "0",
          requestedDisposition: null,
          control: { state: "active" },
        },
        updatedAt: 1,
      });
      const stale = yield* store.commitExecution({
        executionId: "execution-1",
        expectedControlRevision: "0",
        expectedOwnerFence: "0",
        nextControl: {
          executionId: "execution-1",
          ownerFence: "3",
          status: "active",
          rootTaskId: "root",
          stopGeneration: "0",
          requestedDisposition: null,
          control: { state: "stale" },
        },
        updatedAt: 2,
      });
      expect(stale.status).toBe("stale_owner");
      expect((yield* store.loadControl("execution-1"))?.control).toEqual({ state: "active" });
    });
  });
});
