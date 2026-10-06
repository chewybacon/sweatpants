import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { canonicalSnapshot, type Json } from "@sweatpants/foundation";
import { checkpointPayloadFromHotRoots } from "@sweatpants/history-store";
import { run } from "effection";
import { openBetterSqliteStorage } from "../better-sqlite3.ts";
import type { StoredCheckpoint } from "../contract.ts";

const databases: string[] = [];

async function temporaryDatabase(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "sweatpants-storage-sqlite-"));
  databases.push(directory);
  return join(directory, "spine.sqlite");
}

function root(id: string, content: string): Json {
  return {
    rootId: `root:${id}`,
    position: "0",
    kind: "message",
    state: "sealed",
    attribution: {},
    message: { id, role: "user", content },
    placement: { type: "root", sequence: 0 },
  };
}

function checkpoint(hotRoot: Json = root("message-1", "hello")): StoredCheckpoint {
  const snapshot = canonicalSnapshot(checkpointPayloadFromHotRoots([hotRoot], { ready: true }));
  return {
    checkpointId: "checkpoint-1",
    conversationId: "conversation-1",
    lineageId: "lineage-1",
    causeKey: "cause:turn-1",
    cause: { kind: "turn", turnId: "turn-1" },
    contentHash: snapshot.sha,
    archiveHead: null,
    archiveFrontierOrdinal: "0",
    nextPublicPosition: "1",
    payload: snapshot.value,
    encodedBytes: new TextEncoder().encode(snapshot.canonical).byteLength,
    createdAt: 100,
  };
}

afterEach(async () => {
  await Promise.all(databases.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("SQLite checkpoints", () => {
  it("stores the exact typed-root checkpoint and retries immutable identity", async () => {
    const path = await temporaryDatabase();
    const handle = await run(() => openBetterSqliteStorage(path, { initialize: true, wal: false }));
    try {
      const value = checkpoint();
      const pointer = await run(() => handle.storage.conversationStore.putCheckpoint(value));
      const retry = await run(() =>
        handle.storage.conversationStore.putCheckpoint({ ...value, checkpointId: "different-id" }),
      );
      expect(retry).toEqual(pointer);
      expect(await run(() => handle.storage.conversationStore.getCheckpoint(pointer))).toEqual(
        value,
      );

      const rows = handle.database.all(
        sql`SELECT checkpoint_id, lineage_id, archive_frontier_ordinal,
                   next_public_position, payload_json, encoded_bytes
            FROM sp_conversation_checkpoints`,
      ) as Array<Record<string, unknown>>;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        checkpoint_id: "checkpoint-1",
        lineage_id: "lineage-1",
        archive_frontier_ordinal: 0n,
        next_public_position: 1n,
      });
      expect(rows[0]?.["encoded_bytes"]).toBe(
        BigInt(Buffer.byteLength(rows[0]!["payload_json"] as string, "utf8")),
      );
    } finally {
      await run(() => handle.close());
    }
  });

  it("rejects another hash for the same conversation and cause", async () => {
    const path = await temporaryDatabase();
    const handle = await run(() => openBetterSqliteStorage(path, { initialize: true, wal: false }));
    try {
      const value = checkpoint();
      await run(() => handle.storage.conversationStore.putCheckpoint(value));
      await expect(
        run(() =>
          handle.storage.conversationStore.putCheckpoint({
            ...checkpoint(root("message-2", "different")),
            checkpointId: "checkpoint-2",
          }),
        ),
      ).rejects.toMatchObject({ code: "immutable_object_conflict" });
      expect(
        handle.database.all(sql`SELECT checkpoint_id FROM sp_conversation_checkpoints`),
      ).toEqual([{ checkpoint_id: "checkpoint-1" }]);
    } finally {
      await run(() => handle.close());
    }
  });
});
