import { canonicalSnapshot } from "@sweatpants/foundation";
import { run } from "effection";
import { describe, expect, it } from "vitest";
import { ConversationStoreError, type ConversationHeadProposal } from "../contract.ts";
import { createMemoryConversationStore } from "../memory.ts";

const idle: ConversationHeadProposal = {
  state: "idle",
  checkpoint: null,
  terminalHistory: null,
  activeLogicalTurnId: null,
  activeExecutionId: null,
  latestCompletedExecutionId: null,
  activeSegment: null,
  activeCommand: null,
  deletedAt: null,
  ownerTransition: { kind: "clear" },
};

describe("memory conversation store", () => {
  it("writes immutable terminal content before a head CAS and pages by cursor", async () => {
    const store = createMemoryConversationStore();
    const contentHash = canonicalSnapshot([{ turn: "one" }, { turn: "two" }]).sha;
    await run(function* () {
      const initial = yield* store.compareAndSwapHead("conversation", null, null, idle);
      expect(initial.status).toBe("committed");
      const pointer = yield* store.putTerminalHistorySegment({
        segmentId: "segment-1",
        conversationId: "conversation",
        logicalTurnId: "turn-1",
        executionId: "execution-1",
        publicationKey: "turn-1",
        previous: null,
        firstPosition: "0",
        lastPosition: "1",
        entries: [{ turn: "one" }, { turn: "two" }],
        contentHash,
        createdAt: 1,
      });
      expect(
        yield* store.putTerminalHistorySegment({
          segmentId: "segment-1",
          conversationId: "conversation",
          logicalTurnId: "turn-1",
          executionId: "execution-1",
          publicationKey: "turn-1",
          previous: null,
          firstPosition: "0",
          lastPosition: "1",
          entries: [{ turn: "one" }, { turn: "two" }],
          contentHash,
          createdAt: 1,
        }),
      ).toEqual(pointer);

      let publicationConflict: unknown;
      try {
        yield* store.putTerminalHistorySegment({
          segmentId: "other",
          conversationId: "conversation",
          logicalTurnId: "turn-1",
          executionId: "execution-1",
          publicationKey: "turn-1",
          previous: null,
          firstPosition: "0",
          lastPosition: "0",
          entries: [{ turn: "wrong" }],
          contentHash: "hash-wrong",
          createdAt: 1,
        });
      } catch (error) {
        publicationConflict = error;
      }
      expect(publicationConflict).toBeInstanceOf(ConversationStoreError);

      let segmentConflict: unknown;
      try {
        yield* store.putTerminalHistorySegment({
          segmentId: "segment-1",
          conversationId: "conversation",
          logicalTurnId: "turn-2",
          executionId: "execution-2",
          publicationKey: "turn-2",
          previous: null,
          firstPosition: "0",
          lastPosition: "0",
          entries: [{ turn: "replacement" }],
          contentHash: "hash-replacement",
          createdAt: 1,
        });
      } catch (error) {
        segmentConflict = error;
      }
      expect(segmentConflict).toBeInstanceOf(ConversationStoreError);

      const head = (yield* store.loadHead("conversation"))!;
      expect(
        yield* store.compareAndSwapHead("conversation", head.revision, head.ownerEpoch, {
          ...idle,
          terminalHistory: pointer,
          latestCompletedExecutionId: "execution-1",
        }),
      ).toMatchObject({ status: "committed" });
      expect(yield* store.readTerminalHistoryPage("conversation", undefined, 1)).toMatchObject({
        entries: [{ turn: "one" }],
        nextCursor: "1",
      });
      expect(yield* store.readTerminalHistoryPage("conversation", "1", 1)).toMatchObject({
        entries: [{ turn: "two" }],
        nextCursor: null,
      });
    });
  });
});
