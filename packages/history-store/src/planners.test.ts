import { canonicalSnapshot } from "@sweatpants/foundation";
import { describe, expect, it } from "vitest";
import type { ConversationHeadProposal } from "./contract.ts";
import { nextConversationHead, planConversationCommit } from "./planners.ts";
import { encodeConversationHead } from "./persistence.ts";
import { DurableCollections, durableKey } from "@sweatpants/durable-storage-kernel";

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

describe("conversation planners", () => {
  it("is pure and plans immutable publication with one head replacement", () => {
    const current = nextConversationHead("conversation", null, idle, 1);
    const record = {
      collection: DurableCollections.conversationHeads,
      key: durableKey("conversation"),
      revision: current.revision,
      fence: current.ownerEpoch,
      value: encodeConversationHead(current),
    } as const;
    const entries = [{ event: "done" }];
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
    const decision = planConversationCommit({
      currentRecord: record,
      updatedAt: 3,
      request: {
        conversationId: "conversation",
        expectedRevision: "0",
        expectedOwnerEpoch: "0",
        terminalHistorySegment: segment,
        proposal: {
          ...idle,
          terminalHistory: { segmentId: segment.segmentId, lastPosition: "0" },
        },
      },
    });
    expect(decision).toMatchObject({
      kind: "apply",
      mutation: {
        ensures: [{ name: "terminal-history" }],
        authority: { name: "conversation-head", next: { revision: "1" } },
      },
    });
    expect(current).toMatchObject({ revision: "0", terminalHistory: null });
  });
});
