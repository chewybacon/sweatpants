import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { canonicalSnapshot, sha256, sha256Bytes, type Json } from "@sweatpants/foundation";
import { run } from "effection";
import { openBetterSqliteStorage } from "../better-sqlite3.ts";
import { openBetterSqliteStorageForTest } from "../testing.ts";
import type {
  CommitExecutionRequest,
  StoredExecutionObject,
  StoredPrivateSegment,
} from "../contract.ts";

const databases: string[] = [];

async function temporaryDatabase(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "sweatpants-storage-sqlite-"));
  databases.push(directory);
  return join(directory, "spine.sqlite");
}

function privateSegment(
  kind: "journal" | "replay",
  segmentId: string,
  firstSequence: string,
  entries: readonly Json[],
  previous: StoredPrivateSegment["previous"] = null,
): StoredPrivateSegment {
  const snapshot = canonicalSnapshot(entries);
  return {
    segmentId: `${kind}-${segmentId}`,
    executionId: "execution-1",
    taskId: "task-1",
    previous,
    firstSequence,
    lastSequence: String(Number(firstSequence) + entries.length - 1),
    entries: snapshot.value,
    contentHash: sha256(snapshot.canonical),
    encodedBytes: new TextEncoder().encode(snapshot.canonical).byteLength,
    createdAt: 100,
  };
}

function initialCommit(): CommitExecutionRequest {
  const journal = privateSegment("journal", "1", "0", [{ effect: "read-file" }]);
  const replay = privateSegment("replay", "1", "0", [{ replay: "read-file" }]);
  return {
    executionId: "execution-1",
    expectedControlRevision: null,
    expectedOwnerFence: "0",
    nextControl: {
      executionId: "execution-1",
      ownerFence: "0",
      status: "active",
      rootTaskId: "task-1",
      stopGeneration: "0",
      requestedDisposition: null,
      control: { journalHead: journal.segmentId, replayHead: replay.segmentId },
    },
    journalSegments: [journal],
    replaySegments: [replay],
    updatedAt: 100,
  };
}

afterEach(async () => {
  await Promise.all(databases.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("SQLite ExecutionStore", () => {
  it("commits bounded control with journal and replay segments atomically", async () => {
    const path = await temporaryDatabase();
    const handle = await run(() => openBetterSqliteStorage(path, { migrate: true, wal: false }));

    try {
      const committed = await run(() =>
        handle.storage.executionStore.commitExecution(initialCommit()),
      );
      expect(committed).toMatchObject({
        status: "committed",
        control: {
          executionId: "execution-1",
          controlRevision: "0",
          ownerFence: "0",
          status: "active",
        },
      });

      const loaded = await run(() => handle.storage.executionStore.loadControl("execution-1"));
      expect(loaded).toMatchObject({ controlRevision: "0", ownerFence: "0" });

      const journal = await run(() =>
        handle.storage.executionStore.readJournal({
          executionId: "execution-1",
          taskId: "task-1",
          head: { segmentId: "journal-1", lastSequence: "0" },
        }),
      );
      const journalEntries: unknown[] = [];
      for await (const entries of journal) {
        journalEntries.push(...entries);
      }
      expect(journalEntries).toEqual([{ effect: "read-file" }]);

      const replay = await run(() =>
        handle.storage.executionStore.readReplay({
          executionId: "execution-1",
          taskId: "task-1",
          head: { segmentId: "replay-1", lastSequence: "0" },
        }),
      );
      const replayEntries: unknown[] = [];
      for await (const entries of replay) {
        replayEntries.push(...entries);
      }
      expect(replayEntries).toEqual([{ replay: "read-file" }]);
    } finally {
      await run(() => handle.close());
    }
  });

  it("rolls back private segments when settlement fails before control publication", async () => {
    const path = await temporaryDatabase();
    const handle = await run(() =>
      openBetterSqliteStorageForTest(path, {
        migrate: true,
        wal: false,
        faultInjection: "execution-after-segment-insert",
      }),
    );

    try {
      await expect(
        run(() => handle.storage.executionStore.commitExecution(initialCommit())),
      ).rejects.toMatchObject({ code: "sqlite_transaction_failed" });
      const control = await run(() => handle.storage.executionStore.loadControl("execution-1"));
      expect(control).toBeNull();
      const journalRows = handle.database.all(
        sql`SELECT segment_id FROM sp_execution_journal_segments`,
      ) as Array<Record<string, unknown>>;
      const replayRows = handle.database.all(
        sql`SELECT segment_id FROM sp_execution_replay_segments`,
      ) as Array<Record<string, unknown>>;
      expect(journalRows).toEqual([]);
      expect(replayRows).toEqual([]);
    } finally {
      await run(() => handle.close());
    }
  });

  it("rolls back private segments and control when control update fails before commit", async () => {
    const path = await temporaryDatabase();
    const handle = await run(() =>
      openBetterSqliteStorageForTest(path, {
        migrate: true,
        wal: false,
        faultInjection: "execution-before-commit",
      }),
    );

    try {
      await expect(
        run(() => handle.storage.executionStore.commitExecution(initialCommit())),
      ).rejects.toMatchObject({ code: "sqlite_transaction_failed" });
      expect(await run(() => handle.storage.executionStore.loadControl("execution-1"))).toBeNull();
      expect(
        handle.database.all(sql`SELECT segment_id FROM sp_execution_journal_segments`),
      ).toEqual([]);
      expect(handle.database.all(sql`SELECT segment_id FROM sp_execution_replay_segments`)).toEqual(
        [],
      );
    } finally {
      await run(() => handle.close());
    }
  });

  it("fails closed instead of looping forever on a cyclic private chain", async () => {
    const path = await temporaryDatabase();
    const script = fileURLToPath(new URL("./execution-cycle-probe.ts", import.meta.url));
    const result = await new Promise<{
      readonly code: number | null;
      readonly signal: NodeJS.Signals | null;
      readonly stdout: string;
      readonly stderr: string;
    }>((resolve, reject) => {
      const child = spawn("pnpm", ["exec", "tsx", script, path], {
        cwd: process.cwd(),
        env: process.env,
      });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => child.kill("SIGTERM"), 10_000);
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      child.on("error", reject);
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal, stdout, stderr });
      });
    });

    expect(result, result.stderr || result.stdout).toMatchObject({
      code: 0,
      signal: null,
    });
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "error",
      code: "persisted_data_invalid",
    });
  });

  it("round-trips JSON and exact binary execution objects with immutable retry", async () => {
    const path = await temporaryDatabase();
    const handle = await run(() => openBetterSqliteStorage(path, { migrate: true, wal: false }));

    try {
      const jsonBody = canonicalSnapshot({ result: "ok", count: 2 });
      const jsonObject: StoredExecutionObject = {
        objectId: "object-json",
        lifetimeScope: "conversation",
        scopeOwnerId: "conversation-1",
        objectKind: "tool-result",
        contentHash: sha256(jsonBody.canonical),
        byteLength: new TextEncoder().encode(jsonBody.canonical).byteLength,
        body: jsonBody.value,
        createdAt: 100,
      };
      const bytes = new Uint8Array([0, 255, 1, 128]);
      const blobObject: StoredExecutionObject = {
        objectId: "object-blob",
        lifetimeScope: "execution",
        scopeOwnerId: "execution-1",
        objectKind: "artifact",
        contentHash: sha256Bytes(bytes),
        byteLength: bytes.byteLength,
        body: bytes,
        createdAt: 101,
      };

      expect(await run(() => handle.storage.executionStore.putObject(jsonObject))).toEqual({
        objectId: "object-json",
      });
      expect(await run(() => handle.storage.executionStore.putObject(blobObject))).toEqual({
        objectId: "object-blob",
      });
      expect(
        await run(() => handle.storage.executionStore.putObject({ ...jsonObject, createdAt: 999 })),
      ).toEqual({ objectId: "object-json" });
      expect(
        await run(() => handle.storage.executionStore.getObject({ objectId: "object-json" })),
      ).toEqual(jsonObject);
      const loadedBlob = await run(() =>
        handle.storage.executionStore.getObject({ objectId: "object-blob" }),
      );
      expect(loadedBlob).toMatchObject({
        objectId: "object-blob",
        contentHash: sha256Bytes(bytes),
        byteLength: 4,
      });
      expect(loadedBlob?.body).toEqual(bytes);
    } finally {
      await run(() => handle.close());
    }
  });
});
