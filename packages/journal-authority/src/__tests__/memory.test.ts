import { call, run } from "effection";
import { describe, expect, it } from "vitest";
import { type Json, canonicalDigest, canonicalJson } from "@sweatpants/foundation";
import { createMemoryExecutionStore } from "../store/memory.ts";
import type { CommitExecutionRequest, StoredPrivateSegment } from "../store/store.ts";

function initial(executionId: string, control: Json = { state: "open" }): CommitExecutionRequest {
  return {
    executionId,
    expectedControlRevision: null,
    expectedOwnerFence: "0",
    nextControl: {
      executionId,
      ownerFence: "0",
      status: "active",
      rootTaskId: "root",
      stopGeneration: "0",
      requestedDisposition: null,
      control,
    },
    updatedAt: 1,
  };
}

function segment(
  segmentId: string,
  previous: StoredPrivateSegment["previous"],
  entries: readonly Json[],
): StoredPrivateSegment {
  return {
    segmentId,
    executionId: "execution-1",
    taskId: "root",
    previous,
    firstSequence: previous ? "2" : "1",
    lastSequence: previous ? "2" : "1",
    entries,
    contentHash: canonicalDigest(entries),
    encodedBytes: new TextEncoder().encode(canonicalJson(entries)).byteLength,
    createdAt: 1,
  };
}

describe("memory execution store", () => {
  it("uses per-execution CAS and preserves prior immutable replay segments", async () => {
    const store = createMemoryExecutionStore();
    await run(function* () {
      expect(yield* store.loadControl("execution-1")).toBeNull();
      expect(yield* store.commitExecution(initial("execution-1"))).toMatchObject({
        status: "committed",
        control: { controlRevision: "0" },
      });
      expect(yield* store.commitExecution(initial("execution-2"))).toMatchObject({
        status: "committed",
        control: { controlRevision: "0" },
      });

      const first = segment("replay-1", null, [{ outcome: "first" }]);
      const firstPointer = yield* store.appendReplaySegment(first);
      const second = segment("replay-2", firstPointer, [{ outcome: "second" }]);
      const secondPointer = yield* store.appendReplaySegment(second);
      const stream = yield* store.readReplay({
        executionId: "execution-1",
        taskId: "root",
        head: secondPointer,
      });
      const chunks = yield* call(async () => {
        const values: Json[] = [];
        for await (const chunk of stream) values.push(...chunk);
        return values;
      });
      expect(chunks).toEqual([{ outcome: "first" }, { outcome: "second" }]);

      const stale = yield* store.commitExecution({
        ...initial("execution-1"),
        expectedControlRevision: null,
        nextControl: { ...initial("execution-1").nextControl, control: { state: "stale" } },
      });
      expect(stale.status).toBe("control_conflict");
      expect((yield* store.loadControl("execution-2"))?.executionId).toBe("execution-2");
    });
  });
});
