import { call, run } from "effection";
import { describe, expect, it } from "vitest";
import { canonicalSnapshot, type Json } from "@sweatpants/foundation";
import { createMemoryExecutionStore } from "./memory.ts";
import type { StoredPrivateSegment } from "./store.ts";

function control(executionId: string, expectedRevision: string | null, ownerFence = "0") {
  return {
    executionId,
    expectedControlRevision: expectedRevision,
    expectedOwnerFence: ownerFence,
    nextControl: {
      executionId,
      ownerFence,
      status: "active" as const,
      rootTaskId: "root",
      stopGeneration: "0",
      requestedDisposition: null,
      control: { checkpoint: `object-${expectedRevision ?? "initial"}`, journalHead: null },
    },
    updatedAt: Number(expectedRevision ?? "-1") + 2,
  };
}

function privateSegment(
  index: number,
  previous: StoredPrivateSegment["previous"],
): StoredPrivateSegment {
  const entries: Json[] = [{ index }];
  return {
    segmentId: `journal-${index}`,
    executionId: "execution",
    taskId: "root",
    previous,
    firstSequence: String(index + 1),
    lastSequence: String(index + 1),
    entries,
    contentHash: canonicalSnapshot(entries).sha,
    encodedBytes: new TextEncoder().encode(canonicalSnapshot(entries).canonical).byteLength,
    createdAt: index,
  };
}

describe("bounded execution storage semantics", () => {
  it("keeps mutable control bounded while private history grows by segments", async () => {
    const store = createMemoryExecutionStore();
    await run(function* () {
      yield* store.commitExecution({ ...control("execution", null), journalSegments: [] });
      let previous: StoredPrivateSegment["previous"] = null;
      for (let index = 0; index < 31; index += 1) {
        const segment = privateSegment(index, previous);
        const pointer = yield* store.commitExecution({
          ...control("execution", String(index)),
          journalSegments: [segment],
        });
        expect(pointer.status).toBe("committed");
        previous = { segmentId: segment.segmentId, lastSequence: segment.lastSequence };
      }
      const loaded = yield* store.loadControl("execution");
      expect(JSON.stringify(loaded?.control).length).toBeLessThan(256);
      expect(previous?.lastSequence).toBe("31");
    });
  });

  it("streams a task-local replay chain in causal order", async () => {
    const store = createMemoryExecutionStore();
    await run(function* () {
      const first = {
        ...privateSegment(0, null),
        executionId: "execution",
        taskId: "task-a",
        segmentId: "replay-a",
      };
      const firstPointer = yield* store.appendReplaySegment(first);
      const second = {
        ...privateSegment(1, firstPointer),
        executionId: "execution",
        taskId: "task-a",
        segmentId: "replay-b",
      };
      const secondPointer = yield* store.appendReplaySegment(second);
      const stream = yield* store.readReplay({
        executionId: "execution",
        taskId: "task-a",
        head: secondPointer,
      });
      const values = yield* call(async () => {
        const entries: Json[] = [];
        for await (const chunk of stream) entries.push(...chunk);
        return entries;
      });
      expect(values).toEqual([{ index: 0 }, { index: 1 }]);
    });
  });
});
