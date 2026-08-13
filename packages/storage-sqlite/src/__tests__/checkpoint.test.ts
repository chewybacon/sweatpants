import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { canonicalSnapshot, sha256, type JsonObject } from "@sweatpants/foundation";
import { run } from "effection";
import { openBetterSqliteStorage } from "../better-sqlite3.ts";
import type { StoredCheckpoint } from "../contract.ts";

const databases: string[] = [];

async function temporaryDatabase(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "sweatpants-storage-sqlite-"));
  databases.push(directory);
  return join(directory, "spine.sqlite");
}

function checkpoint(
  payload: JsonObject = { public: { hotRoots: [{ message: "hello", count: 1 }] } },
): StoredCheckpoint {
  const snapshot = canonicalSnapshot(payload);
  return {
    checkpointId: "checkpoint-1",
    conversationId: "conversation-1",
    causeKey: "cause:turn-1",
    cause: { kind: "turn", turnId: "turn-1" },
    contentHash: sha256(snapshot.canonical),
    archiveHead: null,
    archiveThroughPosition: "0",
    payload: snapshot.value,
    encodedBytes: new TextEncoder().encode(snapshot.canonical).byteLength,
    createdAt: 100,
  };
}

afterEach(async () => {
  await Promise.all(databases.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("SQLite checkpoints", () => {
  it("stores canonical checkpoint content and retries the immutable key exactly", async () => {
    const path = await temporaryDatabase();
    const handle = await run(() => openBetterSqliteStorage(path, { migrate: true, wal: false }));

    try {
      const value = checkpoint({ public: { hotRoots: [{ z: "last", a: "first" }] } });
      const pointer = await run(() => handle.storage.conversationStore.putCheckpoint(value));
      const retry = await run(() =>
        handle.storage.conversationStore.putCheckpoint({ ...value, checkpointId: "different-id" }),
      );
      expect(retry).toEqual(pointer);

      const loaded = await run(() => handle.storage.conversationStore.getCheckpoint(pointer));
      expect(loaded).toEqual({
        ...value,
        payload: { public: { hotRoots: [{ a: "first", z: "last" }] } },
      });

      const rows = handle.database.all(
        sql`SELECT checkpoint_id, cause_json, payload_json, encoded_bytes
            FROM sp_conversation_checkpoints`,
      ) as Array<{
        checkpoint_id: string;
        cause_json: string;
        payload_json: string;
        encoded_bytes: number;
      }>;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.payload_json).toBe('{"public":{"hotRoots":[{"a":"first","z":"last"}]}}');
      expect(rows[0]?.encoded_bytes).toBe(BigInt(Buffer.byteLength(rows[0]!.payload_json, "utf8")));
    } finally {
      await run(() => handle.close());
    }
  });

  it("rejects another hash for the same conversation and cause", async () => {
    const path = await temporaryDatabase();
    const handle = await run(() => openBetterSqliteStorage(path, { migrate: true, wal: false }));

    try {
      const value = checkpoint();
      await run(() => handle.storage.conversationStore.putCheckpoint(value));
      await expect(
        run(() =>
          handle.storage.conversationStore.putCheckpoint({
            ...checkpoint({ public: { hotRoots: [{ message: "different" }] } }),
            checkpointId: "checkpoint-2",
          }),
        ),
      ).rejects.toMatchObject({ code: "immutable_object_conflict" });

      const rows = handle.database.all(
        sql`SELECT checkpoint_id, content_hash, payload_json FROM sp_conversation_checkpoints`,
      ) as Array<Record<string, unknown>>;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        checkpoint_id: "checkpoint-1",
        payload_json: '{"public":{"hotRoots":[{"count":1,"message":"hello"}]}}',
      });
    } finally {
      await run(() => handle.close());
    }
  });
});
