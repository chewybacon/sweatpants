import { run } from "effection";
import { describe, expect, it } from "vitest";
import { createMemoryExecutionStore } from "../store/memory.ts";
import { inlineControl, runExecutionCommitLoop } from "../store/commit-loop.ts";

describe("direct execution control commit loop", () => {
  it("reads the current control before evaluating mutations and no-op decisions", async () => {
    const store = createMemoryExecutionStore();
    await run(function* () {
      const initial = yield* store.commitExecution({
        executionId: "current-control",
        expectedControlRevision: null,
        expectedOwnerFence: "0",
        nextControl: inlineControl("current-control", "root", "active", { value: 0 }, "0"),
        updatedAt: 1,
      });
      if (initial.status !== "committed") {
        throw new Error("initial commit failed");
      }
      let loads = 0;
      const measured = {
        ...store,
        *loadControl(id: string) {
          loads++;
          return yield* store.loadControl(id);
        },
      };
      const result = yield* runExecutionCommitLoop(measured, "current-control", function* () {
        return {
          status: "commit",
          next: inlineControl("current-control", "root", "parked", { value: 1 }, "0"),
          result: "updated",
        } as const;
      });
      expect(result).toMatchObject({ status: "committed", result: "updated" });
      expect(loads).toBe(1);
      const actual = yield* runExecutionCommitLoop(
        measured,
        "current-control",
        function* (current) {
          return { status: "return", result: current!.control } as const;
        },
      );
      expect(actual).toEqual({ status: "returned", result: { value: 1 } });
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
      expect(result).toMatchObject({ status: "committed", result: "opened" });
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

it("returns only the winning no-op after a competing writer rejects a candidate", async () => {
  const store = createMemoryExecutionStore();
  await run(function* () {
    let attempts = 0;
    const competing = {
      ...store,
      *commitExecution(proposal: Parameters<typeof store.commitExecution>[0]) {
        attempts++;
        yield* store.commitExecution({
          ...proposal,
          nextControl: inlineControl("race", "root", "parked", { winner: "peer" }, "0"),
        });
        return yield* store.commitExecution(proposal);
      },
    };
    const outcome = yield* runExecutionCommitLoop<{
      candidate: string;
      targets: readonly string[];
    }>(competing, "race", function* (current) {
      if (current) {
        return { status: "return", result: { candidate: "peer", targets: [] } } as const;
      }
      return {
        status: "commit",
        next: inlineControl("race", "root", "active", { winner: "loser" }, "0"),
        result: { candidate: "loser", targets: ["unaccepted notification"] },
      } as const;
    });
    expect(attempts).toBe(1);
    expect(outcome).toEqual({ status: "returned", result: { candidate: "peer", targets: [] } });
  });
});

it("returns the acknowledged control rather than the proposed control", async () => {
  const store = createMemoryExecutionStore();
  await run(function* () {
    const outcome = yield* runExecutionCommitLoop(store, "acknowledged", function* () {
      return {
        status: "commit",
        next: inlineControl("acknowledged", "root", "active", null, "0"),
        result: "accepted",
      } as const;
    });
    expect(outcome.status).toBe("committed");
    if (outcome.status !== "committed") {
      throw new Error("expected commit");
    }
    expect(outcome.control).toEqual(yield* store.loadControl("acknowledged"));
    expect(outcome.control.controlRevision).toBe("0");
  });
});

it("rejects a stale fence at the loop boundary without returning a candidate", async () => {
  const store = createMemoryExecutionStore();
  await run(function* () {
    yield* store.commitExecution({
      executionId: "fenced",
      expectedControlRevision: null,
      expectedOwnerFence: "0",
      nextControl: inlineControl("fenced", "root", "active", null, "1"),
      updatedAt: 1,
    });
    const fenced = {
      ...store,
      *commitExecution(proposal: Parameters<typeof store.commitExecution>[0]) {
        return yield* store.commitExecution({ ...proposal, expectedOwnerFence: "0" });
      },
    };
    let caught: unknown;
    try {
      yield* runExecutionCommitLoop(fenced, "fenced", function* () {
        return {
          status: "commit",
          next: inlineControl("fenced", "root", "terminal", null, "1"),
          result: "unaccepted",
        } as const;
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: "stale_owner" });
    expect((yield* store.loadControl("fenced"))?.status).toBe("active");
  });
});
