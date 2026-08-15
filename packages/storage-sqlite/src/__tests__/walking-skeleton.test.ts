import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { run } from "effection";
import { canonicalSnapshot, sha256 } from "@sweatpants/foundation";
import { checkpointPayloadFromHotRoots } from "@sweatpants/history-store";
import { openBetterSqliteStorage } from "../better-sqlite3.ts";

const databases: string[] = [];

async function temporaryDatabase(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "sweatpants-storage-sqlite-"));
  const path = join(directory, "spine.sqlite");
  databases.push(directory);
  return path;
}

afterEach(async () => {
  await Promise.all(databases.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("SQLite durability spine walking skeleton", () => {
  it("migrates the mandatory domain tables without response-tail tables", async () => {
    const path = await temporaryDatabase();
    const handle = await run(() => openBetterSqliteStorage(path, { migrate: true, wal: false }));

    try {
      const rows = handle.database.all(
        sql`SELECT name FROM sqlite_master
          WHERE type = 'table'
            AND name NOT LIKE 'sqlite_%'
            AND name <> '__drizzle_migrations'
          ORDER BY name`,
      ) as Array<{ name: string }>;
      expect(rows.map((row) => row.name)).toEqual([
        "sp_conversation_checkpoints",
        "sp_conversation_command_receipts",
        "sp_conversation_heads",
        "sp_conversation_public_root_index",
        "sp_conversation_public_segments",
        "sp_conversation_terminal_segments",
        "sp_execution_control",
        "sp_execution_journal_segments",
        "sp_execution_objects",
        "sp_execution_replay_segments",
      ]);
      expect(rows.map((row) => row.name)).not.toContain("response_tail_events");
      expect(rows.map((row) => row.name)).not.toContain("response_tail_metadata");
    } finally {
      await run(() => handle.close());
    }
  });

  it("returns separate conversation and execution stores over one Drizzle session", async () => {
    const path = await temporaryDatabase();
    const handle = await run(() => openBetterSqliteStorage(path, { migrate: true, wal: false }));

    try {
      expect(handle.storage.conversationStore).toBeDefined();
      expect(handle.storage.executionStore).toBeDefined();
      expect(handle.storage.conversationStore).not.toBe(handle.storage.executionStore);
      expect(handle.database).toBeDefined();
    } finally {
      await run(() => handle.close());
    }
  });

  it("admits a command, publishes a checkpoint, and returns the head to idle", async () => {
    const path = await temporaryDatabase();
    const handle = await run(() => openBetterSqliteStorage(path, { migrate: true, wal: false }));
    try {
      await run(function* () {
        const store = handle.storage.conversationStore;
        const idle = {
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
        expect(
          yield* store.compareAndSwapHead("conversation_spine_001", null, null, idle),
        ).toMatchObject({ status: "committed", head: { revision: "0" } });
        const admitted = yield* store.admitCommand({
          conversationId: "conversation_spine_001",
          commandId: "command-1",
          commandDigest: "digest-1",
          participantId: "test",
          acceptedAt: 1,
          retainUntil: 10_000,
          expectedRevision: "0",
          requiredState: "idle",
          logicalTurnId: "logical_turn_001",
          executionId: "execution_001",
          proposal: {
            ...idle,
            state: "running",
            activeLogicalTurnId: "logical_turn_001",
            activeExecutionId: "execution_001",
            ownerTransition: { kind: "assign", ownerRoute: { host: "test" } },
          },
        });
        expect(admitted).toMatchObject({ status: "admitted", head: { state: "running" } });
        const root = {
          rootId: "message:start",
          position: "0",
          kind: "message",
          state: "sealed",
          attribution: {},
          message: { id: "start", role: "user", content: "start" },
          placement: { type: "root", sequence: 0 },
        };
        const payload = canonicalSnapshot(checkpointPayloadFromHotRoots([root]));
        const pointer = yield* store.putCheckpoint({
          checkpointId: "checkpoint-1",
          conversationId: "conversation_spine_001",
          causeKey: "command-1",
          cause: { kind: "command", commandId: "command-1" },
          contentHash: payload.sha,
          lineageId: "lineage-1",
          archiveHead: null,
          archiveFrontierOrdinal: "0",
          nextPublicPosition: "1",
          payload: payload.value,
          encodedBytes: new TextEncoder().encode(payload.canonical).byteLength,
          createdAt: 1,
        });
        const idleHead = yield* store.compareAndSwapHead(
          "conversation_spine_001",
          admitted.status === "admitted" ? admitted.head.revision : "1",
          admitted.status === "admitted" ? admitted.head.ownerEpoch : "1",
          { ...idle, checkpoint: pointer, latestCompletedExecutionId: "execution_001" },
        );
        expect(idleHead).toMatchObject({
          status: "committed",
          head: { state: "idle", activeExecutionId: null },
        });
        expect(sha256(payload.canonical)).toBe(payload.sha);
      });
    } finally {
      await run(() => handle.close());
    }
  });
});
