import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalSnapshot, sha256 } from "@sweatpants/foundation";
import { run } from "effection";
import { openBetterSqliteStorage } from "../better-sqlite3.ts";
import { inspectionSql, readStorageReport } from "../inspection.ts";

const databases: string[] = [];

async function temporaryDatabase(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "sweatpants-storage-sqlite-"));
  databases.push(directory);
  return join(directory, "spine.sqlite");
}

afterEach(async () => {
  await Promise.all(databases.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("SQLite inspection", () => {
  it("reports real table counts and bytes without exposing bodies", async () => {
    const path = await temporaryDatabase();
    const handle = await run(() => openBetterSqliteStorage(path, { migrate: true, wal: false }));

    try {
      const payload = canonicalSnapshot({
        public: {
          hotRoots: [
            {
              rootId: "root:secret",
              position: "0",
              kind: "message",
              state: "sealed",
              attribution: {},
              message: { id: "secret", role: "user", content: "PRIVATE_MARKER" },
              placement: { type: "root", sequence: 0 },
            },
          ],
          applicationState: {},
        },
      });
      await run(() =>
        handle.storage.conversationStore.putCheckpoint({
          checkpointId: "checkpoint-1",
          conversationId: "conversation-1",
          causeKey: "cause-1",
          cause: { kind: "test" },
          contentHash: sha256(payload.canonical),
          lineageId: "lineage-1",
          archiveHead: null,
          archiveFrontierOrdinal: "0",
          nextPublicPosition: "1",
          payload: payload.value,
          encodedBytes: new TextEncoder().encode(payload.canonical).byteLength,
          createdAt: 100,
        }),
      );

      const report = readStorageReport(handle.database);
      expect(report.tables["sp_conversation_checkpoints"]).toEqual({
        rows: 1,
        encodedBytes: new TextEncoder().encode(payload.canonical).byteLength,
      });
      expect(report.checkpointWriteBytes).toBe(
        new TextEncoder().encode(payload.canonical).byteLength,
      );
      expect(report.journalByTask).toEqual([]);
      expect(JSON.stringify(report)).not.toContain("PRIVATE_MARKER");
      expect(inspectionSql.cleanupCheckpointOrphans).toContain("NOT EXISTS");
    } finally {
      await run(() => handle.close());
    }
  });
});
