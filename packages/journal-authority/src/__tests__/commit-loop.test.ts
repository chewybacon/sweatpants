import { run } from "effection";
import { describe, expect, it } from "vitest";
import { createMemoryExecutionStore } from "../store/memory.ts";
import { inlineControl, runExecutionCommitLoop } from "../store/commit-loop.ts";

describe("direct execution control commit loop", () => {
  it("uses an accepted revision for CAS but refreshes stale no-op decisions", async () => {
    const store = createMemoryExecutionStore();
    await run(function* () {
      const initial = yield* store.commitExecution({
        executionId: "optimistic",
        expectedControlRevision: null,
        expectedOwnerFence: "0",
        nextControl: inlineControl("optimistic", "root", "active", { value: 0 }, "0"),
        updatedAt: 1,
      });
      if (initial.status !== "committed") throw new Error("initial commit failed");
      let loads = 0;
      const measured = {
        ...store,
        *loadControl(id: string) {
          loads++;
          return yield* store.loadControl(id);
        },
      };
      const result = yield* runExecutionCommitLoop(
        measured,
        "optimistic",
        function* () {
          return {
            status: "commit",
            next: inlineControl("optimistic", "root", "parked", { value: 1 }, "0"),
            result: "updated",
          } as const;
        },
        64,
        initial.control,
      );
      expect(result).toBe("updated");
      expect(loads).toBe(0);
      const actual = yield* runExecutionCommitLoop(
        measured,
        "optimistic",
        function* (current) {
          return { status: "return", result: current!.control } as const;
        },
        64,
        initial.control,
      );
      expect(actual).toEqual({ value: 1 });
      expect(loads).toBe(2);
    });
  });

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
