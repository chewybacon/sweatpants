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

describe.each(conversationCases())("conversation store conformance ($name)", ({ create }) => {
  it("rejects a gap in public segment positions consistently across adapters", async () => {
    const handle = await create();
    try {
      await run(function* () {
        const firstRoots: Json[] = [{ position: 0 }];
        const firstEncoded = canonicalSnapshot(firstRoots);
        const first: StoredPublicArchiveSegment = {
          segmentId: "public-0",
          conversationId: "conv",
          previous: null,
          firstPosition: "0",
          lastPosition: "0",
          roots: firstRoots,
          contentHash: sha256(firstEncoded.canonical),
          encodedBytes: new TextEncoder().encode(firstEncoded.canonical).byteLength,
          createdAt: 1,
        };
        const secondRoots: Json[] = [{ position: 2 }];
        const secondEncoded = canonicalSnapshot(secondRoots);
        const second: StoredPublicArchiveSegment = {
          segmentId: "public-2",
          conversationId: "conv",
          previous: { segmentId: first.segmentId, lastPosition: "0" },
          firstPosition: "2",
          lastPosition: "2",
          roots: secondRoots,
          contentHash: sha256(secondEncoded.canonical),
          encodedBytes: new TextEncoder().encode(secondEncoded.canonical).byteLength,
          createdAt: 2,
        };
        yield* handle.store.putPublicArchiveSegment(first);
        yield* handle.store.putPublicArchiveSegment(second);

        let error: unknown;
        try {
          yield* handle.store.readPublicArchivePage("conv", undefined, 10);
        } catch (cause) {
          error = cause;
        }
        expect(error).toMatchObject({ code: "persisted_data_invalid" });
      });
    } finally {
      await handle.close();
    }
  });

  it("retries immutable checkpoints and conflicts on a different hash", async () => {
    const handle = await create();
    try {
      await run(function* () {
        const payload = canonicalSnapshot(checkpointPayloadFromHotRoots([{ n: 1 }]));
        const checkpoint = {
          checkpointId: "c1",
          conversationId: "conv",
          causeKey: "cause",
          cause: { kind: "command", commandId: "one" },
          contentHash: payload.sha,
          archiveHead: null,
          archiveThroughPosition: "0",
          payload: payload.value,
          encodedBytes: new TextEncoder().encode(payload.canonical).byteLength,
          createdAt: 1,
        };
        const pointer = yield* handle.store.putCheckpoint(checkpoint);
        expect(yield* handle.store.putCheckpoint({ ...checkpoint, checkpointId: "other" })).toEqual(
          pointer,
        );
        const other = canonicalSnapshot(checkpointPayloadFromHotRoots([{ n: 2 }]));
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
