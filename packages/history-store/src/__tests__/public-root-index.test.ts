import { canonicalSnapshot } from "@sweatpants/foundation";
import { run } from "effection";
import { describe, expect, it } from "vitest";
import type {
  ArchivedPublicRootIndex,
  ConversationHeadProposal,
  StoredPublicArchiveSegment,
} from "../contract.ts";
import { checkpointPayloadFromHotRoots } from "../checkpoint-payload.ts";
import { createMemoryConversationStore } from "../memory.ts";

const initial: ConversationHeadProposal = {
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

function root(rootId: string, position: string) {
  return {
    rootId,
    position,
    kind: "message",
    state: "sealed",
    attribution: {},
    message: { id: rootId, role: "user", content: rootId },
    placement: { type: "root", sequence: Number(position) },
  } as const;
}

describe("accepted public root-position index", () => {
  it("reads bounded history backward without walking the archive chain", async () => {
    const store = createMemoryConversationStore();
    await run(function* () {
      const created = yield* store.compareAndSwapHead("conversation", null, null, initial);
      if (created.status !== "committed") throw new Error("failed to create head");
      const roots = [root("root-0", "0"), root("root-1", "1")];
      const segmentSnapshot = canonicalSnapshot(roots);
      const segment: StoredPublicArchiveSegment = {
        segmentId: "segment-1",
        conversationId: "conversation",
        previous: null,
        minPosition: "0",
        maxPosition: "1",
        roots,
        contentHash: segmentSnapshot.sha,
        encodedBytes: new TextEncoder().encode(segmentSnapshot.canonical).byteLength,
        createdAt: 1,
      };
      const index: ArchivedPublicRootIndex[] = roots.map((value, slot) => {
        const snapshot = canonicalSnapshot(value);
        return {
          conversationId: "conversation",
          position: value.position,
          rootId: value.rootId,
          segmentId: segment.segmentId,
          segmentRootIndex: slot,
          archiveOrdinal: String(slot),
          contentHash: snapshot.sha,
          encodedBytes: new TextEncoder().encode(snapshot.canonical).byteLength,
        };
      });
      const payloadValue = checkpointPayloadFromHotRoots([]);
      const payload = canonicalSnapshot(payloadValue);
      const checkpoint = {
        checkpointId: "checkpoint-1",
        conversationId: "conversation",
        causeKey: "cause-1",
        cause: { kind: "test" } as const,
        contentHash: payload.sha,
        lineageId: "lineage",
        archiveHead: { segmentId: segment.segmentId },
        archiveFrontierOrdinal: "2",
        nextPublicPosition: "2",
        payload: payload.value,
        encodedBytes: new TextEncoder().encode(payload.canonical).byteLength,
        createdAt: 1,
      };
      const committed = yield* store.commitConversation({
        conversationId: "conversation",
        expectedRevision: created.head.revision,
        expectedOwnerEpoch: created.head.ownerEpoch,
        proposal: { ...initial, checkpoint: { checkpointId: checkpoint.checkpointId } },
        publicArchiveSegments: [segment],
        publicArchiveRootIndex: index,
        checkpoint,
        updatedAt: 1,
      });
      expect(committed.status).toBe("committed");

      const first = yield* store.readPublicHistoryBefore({
        conversationId: "conversation",
        basis: {
          lineageId: "lineage",
          basisRevision: "1",
          archiveFrontierOrdinal: "2",
          nextPublicPosition: "2",
          hotRootPositions: [],
        },
        beforePosition: "2",
        maxRoots: 1,
        maxBytes: 1024 * 1024,
      });
      expect(first.roots).toEqual([roots[1]]);
      expect(first.nextBeforePosition).toBe("1");
      const second = yield* store.readPublicHistoryBefore({
        conversationId: "conversation",
        basis: {
          lineageId: "lineage",
          basisRevision: "1",
          archiveFrontierOrdinal: "2",
          nextPublicPosition: "2",
          hotRootPositions: [],
        },
        beforePosition: first.nextBeforePosition!,
        maxRoots: 10,
        maxBytes: 1024 * 1024,
      });
      expect(second.roots).toEqual([roots[0]]);
      expect(second.nextBeforePosition).toBeNull();
    });
  });
});
