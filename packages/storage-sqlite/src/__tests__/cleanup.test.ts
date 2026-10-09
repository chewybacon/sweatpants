import { sql } from "drizzle-orm";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalSnapshot, sha256 } from "@sweatpants/foundation";
import { run } from "effection";
import { openBetterSqliteStorage } from "../better-sqlite3.ts";
import { cleanupCheckpointOrphans, inspectionSql } from "../inspection.ts";

const databases: string[] = [];

async function temporaryDatabase(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "sweatpants-storage-sqlite-"));
  databases.push(directory);
  return join(directory, "spine.sqlite");
}

function checkpoint(id: string, conversationId: string, createdAt: number) {
  const payload = canonicalSnapshot({
    public: {
      hotRoots: [
        {
          rootId: `root:${id}`,
          position: "0",
          kind: "message",
          state: "sealed",
          attribution: {},
          message: { id, role: "user", content: id },
          placement: { type: "root", sequence: 0 },
        },
      ],
      applicationState: {},
    },
  });
  return {
    checkpointId: id,
    conversationId,
    causeKey: `cause-${id}`,
    cause: { kind: "test", id },
    contentHash: sha256(payload.canonical),
    lineageId: `lineage-${conversationId}`,
    archiveHead: null,
    archiveFrontierOrdinal: "0",
    nextPublicPosition: "1",
    payload: payload.value,
    encodedBytes: new TextEncoder().encode(payload.canonical).byteLength,
    createdAt,
  } as const;
}

afterEach(async () => {
  await Promise.all(databases.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("checkpoint orphan cleanup", () => {
  it("removes only expired unreferenced checkpoints", async () => {
    const path = await temporaryDatabase();
    const handle = await run(() => openBetterSqliteStorage(path, { initialize: true, wal: false }));

    try {
      const orphan = checkpoint("orphan", "conversation-1", 10);
      const referenced = checkpoint("referenced", "conversation-1", 10);
      await run(() => handle.storage.conversationStore.putCheckpoint(orphan));
      const referencedPointer = await run(() =>
        handle.storage.conversationStore.putCheckpoint(referenced),
      );
      await run(() =>
        handle.storage.conversationStore.compareAndSwapHead("conversation-1", null, null, {
          state: "idle",
          checkpoint: referencedPointer,
          terminalHistory: null,
          activeLogicalTurnId: null,
          activeExecutionId: null,
          latestCompletedExecutionId: null,
          activeSegment: null,
          activeCommand: null,
          deletedAt: null,
          ownerTransition: { kind: "preserve" },
        }),
      );

      const plan = handle.database.all(
        sql.raw(`EXPLAIN QUERY PLAN ${inspectionSql.cleanupCheckpointOrphans.replace("?", "11")}`),
      ) as { detail: string }[];
      const details = plan.map((row) => row.detail).join("\n");
      expect(details).toMatch(/SEARCH head USING INDEX .*conversation_id=/);
      expect(details).not.toMatch(/SCAN head/);
      expect(cleanupCheckpointOrphans(handle.database, 10)).toBe(0);
      expect(cleanupCheckpointOrphans(handle.database, 11)).toBe(1);
      expect(
        await run(() => handle.storage.conversationStore.getCheckpoint({ checkpointId: "orphan" })),
      ).toBeNull();
      expect(
        await run(() => handle.storage.conversationStore.getCheckpoint(referencedPointer)),
      ).not.toBeNull();
    } finally {
      await run(() => handle.close());
    }
  });
});
