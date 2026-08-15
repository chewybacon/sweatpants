import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalSnapshot, sha256, type Json } from "@sweatpants/foundation";
import { call, run } from "effection";
import { createMemoryConversationStore } from "@sweatpants/history-store/memory";
import type {
  ConversationStore,
  StoredPublicArchiveSegment,
} from "@sweatpants/history-store/contract";
import { createMemoryExecutionStore } from "@sweatpants/journal-authority/memory";
import type { ExecutionStore } from "@sweatpants/journal-authority/store";
import { checkpointPayloadFromHotRoots } from "@sweatpants/history-store";
import { openBetterSqliteStorage } from "../better-sqlite3.ts";

const databases: string[] = [];

async function temporaryDatabase(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "sweatpants-storage-sqlite-"));
  databases.push(directory);
  return join(directory, "spine.sqlite");
}

afterEach(async () => {
  await Promise.all(databases.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function conversationCases(): Array<{
  name: string;
  create: () => Promise<{ store: ConversationStore; close: () => Promise<void> }>;
}> {
  return [
    {
      name: "memory",
      async create() {
        return { store: createMemoryConversationStore(), close: async () => undefined };
      },
    },
    {
      name: "sqlite",
      async create() {
        const path = await temporaryDatabase();
        const handle = await run(() =>
          openBetterSqliteStorage(path, { migrate: true, wal: false }),
        );
        return {
          store: handle.storage.conversationStore,
          close: () => run(() => handle.close()),
        };
      },
    },
  ];
}

function executionCases(): Array<{
  name: string;
  create: () => Promise<{ store: ExecutionStore; close: () => Promise<void> }>;
}> {
  return [
    {
      name: "memory",
      async create() {
        return { store: createMemoryExecutionStore(), close: async () => undefined };
      },
    },
    {
      name: "sqlite",
      async create() {
        const path = await temporaryDatabase();
        const handle = await run(() =>
          openBetterSqliteStorage(path, { migrate: true, wal: false }),
        );
        return {
          store: handle.storage.executionStore,
          close: () => run(() => handle.close()),
        };
      },
    },
  ];
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

describe.each(conversationCases())("conversation store conformance ($name)", ({ create }) => {
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
        expect(yield* handle.store.putCheckpoint({ ...checkpoint, checkpointId: "other" })).toEqual(
          pointer,
        );
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

describe.each(executionCases())("execution store conformance ($name)", ({ create }) => {
  it("retries immutable objects and streams a task-local chain", async () => {
    const handle = await create();
    try {
      await run(function* () {
        const firstEntries: Json[] = [{ n: 1 }];
        const firstEncoded = canonicalSnapshot(firstEntries);
        const first = yield* handle.store.appendJournalSegment({
          segmentId: "j1",
          executionId: "ex",
          taskId: "task",
          previous: null,
          firstSequence: "1",
          lastSequence: "1",
          entries: firstEntries,
          contentHash: sha256(firstEncoded.canonical),
          encodedBytes: new TextEncoder().encode(firstEncoded.canonical).byteLength,
          createdAt: 1,
        });
        const secondEntries: Json[] = [{ n: 2 }];
        const secondEncoded = canonicalSnapshot(secondEntries);
        const second = yield* handle.store.appendJournalSegment({
          segmentId: "j2",
          executionId: "ex",
          taskId: "task",
          previous: first,
          firstSequence: "2",
          lastSequence: "2",
          entries: secondEntries,
          contentHash: sha256(secondEncoded.canonical),
          encodedBytes: new TextEncoder().encode(secondEncoded.canonical).byteLength,
          createdAt: 2,
        });
        const stream = yield* handle.store.readJournal({
          executionId: "ex",
          taskId: "task",
          head: second,
        });
        const values = yield* call(async () => {
          const collected: Json[] = [];
          for await (const chunk of stream) {
            collected.push(...chunk);
          }
          return collected;
        });
        expect(values).toEqual([{ n: 1 }, { n: 2 }]);
      });
    } finally {
      await handle.close();
    }
  });
});
