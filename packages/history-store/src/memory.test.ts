import { run } from "effection";
import { describe, expect, it } from "vitest";
import { createMemoryHistoryStore } from "./memory.ts";

describe("memory history store", () => {
  it("writes immutable content before an idempotent head CAS and pages by cursor", async () => {
    const store = createMemoryHistoryStore<{ turn: string }>();
    await run(function* () {
      const pointer = yield* store.putSegment({
        segmentId: "segment-1",
        publicationKey: "turn-1",
        sessionId: "session",
        previous: null,
        firstPosition: 0,
        lastPosition: 1,
        entries: [{ turn: "one" }, { turn: "two" }],
      });
      expect(
        yield* store.putSegment({
          segmentId: "other",
          publicationKey: "turn-1",
          sessionId: "session",
          previous: null,
          firstPosition: 0,
          lastPosition: 1,
          entries: [{ turn: "wrong" }],
        }),
      ).toEqual(pointer);
      expect(
        yield* store.compareAndSwapHead("session", null, {
          sessionId: "session",
          revision: 0,
          historyHead: pointer,
          activeExecutionId: null,
          latestCompletedExecutionId: "execution-1",
        }),
      ).toMatchObject({ status: "accepted" });
      expect(yield* store.readPage("session", undefined, 1)).toMatchObject({
        entries: [{ turn: "one" }],
        nextCursor: "1",
      });
      expect(yield* store.readPage("session", "1", 1)).toMatchObject({
        entries: [{ turn: "two" }],
        nextCursor: null,
      });
    });
  });
});
