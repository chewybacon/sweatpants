import { run } from "effection";
import { describe, expect, it } from "vitest";
import { HistorySegmentConflictError } from "./contract.ts";
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
          segmentId: "segment-1",
          publicationKey: "turn-1",
          sessionId: "session",
          previous: null,
          firstPosition: 0,
          lastPosition: 1,
          entries: [{ turn: "one" }, { turn: "two" }],
        }),
      ).toEqual(pointer);
      let publicationConflict: unknown;
      try {
        yield* store.putSegment({
          segmentId: "other",
          publicationKey: "turn-1",
          sessionId: "session",
          previous: null,
          firstPosition: 0,
          lastPosition: 0,
          entries: [{ turn: "wrong" }],
        });
      } catch (error) {
        publicationConflict = error;
      }
      expect(publicationConflict).toBeInstanceOf(HistorySegmentConflictError);

      let segmentConflict: unknown;
      try {
        yield* store.putSegment({
          segmentId: "segment-1",
          publicationKey: "turn-2",
          sessionId: "session",
          previous: null,
          firstPosition: 0,
          lastPosition: 0,
          entries: [{ turn: "replacement" }],
        });
      } catch (error) {
        segmentConflict = error;
      }
      expect(segmentConflict).toBeInstanceOf(HistorySegmentConflictError);
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
