import { canonicalSnapshot } from "@sweatpants/foundation";
import { run } from "effection";
import { describe, expect, it } from "vitest";
import { createMemoryConversationStore } from "./memory.ts";
import type { CommandAdmissionRequest, ConversationHeadProposal } from "./contract.ts";

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
  it("preserves idempotent command retries and reports identity evidence on divergence", async () => {
    const store = createMemoryConversationStore();
    await run(function* () {
      expect(yield* store.compareAndSwapHead("conversation", null, null, idle)).toMatchObject({
        status: "committed",
        head: { revision: "0" },
      });

      const request = commandRequest();
      const admitted = yield* store.admitCommand(request);
      expect(admitted).toMatchObject({
        status: "admitted",
        receipt: { commandDigest: "digest-1" },
      });
      if (admitted.status !== "admitted") throw new Error("command was not admitted");

      const retried = yield* store.admitCommand(request);
      expect(retried).toMatchObject({
        status: "idempotent",
        receipt: admitted.receipt,
      });

      expect(yield* store.admitCommand(commandRequest("digest-2"))).toEqual({
        status: "command_identity_conflict",
        receipt: admitted.receipt,
        conflict: {
          domain: "conversation-command",
          key: "conversation/command-1",
          guard: "identity",
          expected: "digest-2",
          observed: "digest-1",
        },
      });
    });
  });

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

function commandRequest(commandDigest = "digest-1"): CommandAdmissionRequest {
  return {
    conversationId: "conversation",
    commandId: "command-1",
    commandDigest,
    participantId: "participant-1",
    acceptedAt: 1,
    retainUntil: 100,
    expectedRevision: "0",
    requiredState: "idle",
    logicalTurnId: "turn-1",
    executionId: "execution-1",
    proposal: {
      ...idle,
      state: "running",
      activeLogicalTurnId: "turn-1",
      activeExecutionId: "execution-1",
      activeCommand: {
        kind: "send-message",
        commandId: "command-1",
        logicalTurnId: "turn-1",
        executionId: "execution-1",
      },
      ownerTransition: {
        kind: "assign",
        ownerRoute: { executionId: "execution-1", taskId: "task-1" },
      },
    },
  };
}
