import { canonicalSnapshot } from "@sweatpants/foundation";
import { run } from "effection";
import { describe, expect, it } from "vitest";
import { createMemoryConversationStore } from "./memory.ts";
import type { ConversationHeadProposal } from "./contract.ts";

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

describe("kernel conversation repository", () => {
  it("publishes terminal content and the selecting head in one semantic commit", async () => {
    const store = createMemoryConversationStore();
    await run(function* () {
      const initial = yield* store.compareAndSwapHead("conversation", null, null, idle);
      expect(initial.status).toBe("committed");
      const entries = [{ event: "complete" }];
      const segment = {
        segmentId: "terminal-1",
        conversationId: "conversation",
        logicalTurnId: "turn-1",
        executionId: "execution-1",
        publicationKey: "turn-1",
        previous: null,
        firstPosition: "0",
        lastPosition: "0",
        entries,
        contentHash: canonicalSnapshot(entries).sha,
        createdAt: 2,
      } as const;
      const committed = yield* store.commitConversation({
        conversationId: "conversation",
        expectedRevision: "0",
        expectedOwnerEpoch: "0",
        terminalHistorySegment: segment,
        proposal: {
          ...idle,
          terminalHistory: { segmentId: segment.segmentId, lastPosition: "0" },
          latestCompletedExecutionId: segment.executionId,
        },
        updatedAt: 3,
      });
      expect(committed).toMatchObject({
        status: "committed",
        head: { revision: "1", terminalHistory: { segmentId: "terminal-1" } },
      });
      expect(yield* store.readTerminalHistoryPage("conversation")).toMatchObject({
        entries,
        head: { segmentId: "terminal-1" },
      });
    });
  });
});
