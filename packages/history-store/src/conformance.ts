import { canonicalSnapshot, type Json } from "@sweatpants/foundation";
import { run } from "effection";
import { describe, expect, it } from "vitest";
import { checkpointPayloadFromHotRoots } from "./checkpoint-payload.ts";
import type {
  ConversationStore,
  StoredPublicArchiveSegment,
} from "./contract.ts";

export interface ConversationStoreBackendCase {
  readonly name: string;
  readonly create: () => Promise<{
    readonly store: ConversationStore;
    readonly close: () => Promise<void>;
  }>;
}

function publicRoot(rootId: string, position: string, content = rootId): Json {
  return {
    rootId,
    position,
    kind: "message",
    state: "sealed",
    attribution: {},
    message: { id: rootId, role: "user", content },
    placement: { type: "root", sequence: Number(position) },
  };
}

/**
 * Store-level conformance for conversation durability. Every storage backend
 * MUST pass these cases unchanged.
 */
export function describeConversationStoreConformance(
  cases: readonly ConversationStoreBackendCase[],
): void {
  describe.each([...cases])("conversation store conformance ($name)", ({ create }) => {
    it("accepts noncontiguous public segment positions consistently across adapters", async () => {
      const handle = await create();
      try {
        await run(function* () {
          const roots = [publicRoot("root-2", "2"), publicRoot("root-7", "7")];
          const encoded = canonicalSnapshot(roots);
          const pointer = yield* handle.store.putPublicArchiveSegment({
            segmentId: "public-sparse",
            conversationId: "conv",
            previous: null,
            minPosition: "2",
            maxPosition: "7",
            roots,
            contentHash: encoded.sha,
            encodedBytes: new TextEncoder().encode(encoded.canonical).byteLength,
            createdAt: 1,
          });
          expect(pointer).toEqual({ segmentId: "public-sparse" });
        });
      } finally {
        await handle.close();
      }
    });

    it("publishes and pages the accepted public root index atomically", async () => {
      const handle = await create();
      try {
        await run(function* () {
          const proposal = {
            state: "idle" as const,
            checkpoint: null,
            terminalHistory: null,
            activeLogicalTurnId: null,
            activeExecutionId: null,
            latestCompletedExecutionId: null,
            activeSegment: null,
            activeCommand: null,
            deletedAt: null,
            ownerTransition: { kind: "clear" as const },
          };
          const created = yield* handle.store.compareAndSwapHead("indexed", null, null, proposal);
          if (created.status !== "committed") throw new Error("failed to create conversation");
          const root = {
            rootId: "root-0",
            position: "0",
            kind: "message",
            state: "sealed",
            attribution: {},
            message: { id: "message-0", role: "user", content: "hello" },
            placement: { type: "root", sequence: 0 },
          } as const;
          const roots = [root];
          const rootsSnapshot = canonicalSnapshot(roots);
          const segment: StoredPublicArchiveSegment = {
            segmentId: "indexed-segment",
            conversationId: "indexed",
            previous: null,
            minPosition: "0",
            maxPosition: "0",
            roots,
            contentHash: rootsSnapshot.sha,
            encodedBytes: new TextEncoder().encode(rootsSnapshot.canonical).byteLength,
            createdAt: 1,
          };
          const rootSnapshot = canonicalSnapshot(root);
          const payload = canonicalSnapshot(checkpointPayloadFromHotRoots([]));
          const checkpoint = {
            checkpointId: "indexed-checkpoint",
            conversationId: "indexed",
            causeKey: "indexed-cause",
            cause: { kind: "test" } as const,
            contentHash: payload.sha,
            lineageId: "lineage",
            archiveHead: { segmentId: segment.segmentId },
            archiveFrontierOrdinal: "1",
            nextPublicPosition: "1",
            payload: payload.value,
            encodedBytes: new TextEncoder().encode(payload.canonical).byteLength,
            createdAt: 1,
          };
          const committed = yield* handle.store.commitConversation({
            conversationId: "indexed",
            expectedRevision: created.head.revision,
            expectedOwnerEpoch: created.head.ownerEpoch,
            proposal: { ...proposal, checkpoint: { checkpointId: checkpoint.checkpointId } },
            publicArchiveSegments: [segment],
            publicArchiveRootIndex: [
              {
                conversationId: "indexed",
                position: "0",
                rootId: root.rootId,
                segmentId: segment.segmentId,
                segmentRootIndex: 0,
                archiveOrdinal: "0",
                contentHash: rootSnapshot.sha,
                encodedBytes: new TextEncoder().encode(rootSnapshot.canonical).byteLength,
              },
            ],
            checkpoint,
            updatedAt: 1,
          });
          expect(committed.status).toBe("committed");
          expect(
            yield* handle.store.readPublicHistoryBefore({
              conversationId: "indexed",
              basis: {
                lineageId: "lineage",
                basisRevision: "1",
                archiveFrontierOrdinal: "1",
                nextPublicPosition: "1",
                hotRootPositions: [],
              },
              beforePosition: "1",
              maxRoots: 100,
              maxBytes: 1024 * 1024,
            }),
          ).toEqual({ roots: [root], nextBeforePosition: null });
        });
      } finally {
        await handle.close();
      }
    });

    it("retries immutable checkpoints and conflicts on a different hash", async () => {
      const handle = await create();
      try {
        await run(function* () {
          const firstRoot = publicRoot("message-1", "0", "one");
          const payload = canonicalSnapshot(checkpointPayloadFromHotRoots([firstRoot]));
          const checkpoint = {
            checkpointId: "c1",
            conversationId: "conv",
            lineageId: "lineage",
            causeKey: "cause",
            cause: { kind: "command", commandId: "one" },
            contentHash: payload.sha,
            archiveHead: null,
            archiveFrontierOrdinal: "0",
            nextPublicPosition: "1",
            payload: payload.value,
            encodedBytes: new TextEncoder().encode(payload.canonical).byteLength,
            createdAt: 1,
          };
          const pointer = yield* handle.store.putCheckpoint(checkpoint);
          expect(
            yield* handle.store.putCheckpoint({ ...checkpoint, checkpointId: "other" }),
          ).toEqual(pointer);
          const other = canonicalSnapshot(
            checkpointPayloadFromHotRoots([publicRoot("message-2", "0", "two")]),
          );
          let conflict: unknown;
          try {
            yield* handle.store.putCheckpoint({
              ...checkpoint,
              checkpointId: "c2",
              contentHash: other.sha,
              payload: other.value,
              encodedBytes: new TextEncoder().encode(other.canonical).byteLength,
            });
          } catch (error) {
            conflict = error;
          }
          expect(conflict).toMatchObject({ code: "immutable_object_conflict" });
        });
      } finally {
        await handle.close();
      }
    });
  });
}
