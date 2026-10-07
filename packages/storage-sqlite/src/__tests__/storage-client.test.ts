import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import { run } from "effection";
import { afterEach, describe, expect, it } from "vitest";
import { createSqliteWriterBinding, openBetterSqliteStorage } from "../better-sqlite3.ts";
import {
  createChatStorageClient,
  openChatStorageReader,
  type ThreadSummary,
  type TranscriptPage,
} from "../client.ts";
import { canonicalDigest } from "@sweatpants/foundation";
import { terminalToRow } from "@sweatpants/history-store/sql-codec";
import { spConversationTerminalSegments, sqliteSchema } from "../schema.ts";

const roots: string[] = [];
const closables: Array<{ close(): void }> = [];

afterEach(() => {
  for (const closable of closables.splice(0).reverse()) {
    try {
      closable.close();
    } catch {
      // Teardown best effort.
    }
  }
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function tempFile(name: string): string {
  return join(roots[roots.length - 1]!, name);
}

function track<T extends { close(): void }>(closable: T): T {
  closables.push(closable);
  return closable;
}

async function initializeFile(path: string): Promise<void> {
  await run(function* () {
    const handle = yield* openBetterSqliteStorage(path, { initialize: true });
    yield* handle.close();
  });
}

function clientDrizzle(binding: Database.Database): BetterSQLite3Database<typeof sqliteSchema> {
  return drizzle(binding, { schema: sqliteSchema });
}

function seedAuthorityData(path: string): void {
  const raw = track(new Database(path));
  const insertHead = raw.prepare(
    `INSERT INTO sp_conversation_heads
       (conversation_id, revision, owner_epoch, state, deleted_at, updated_at)
     VALUES (?, 0, 0, ?, ?, ?)`,
  );
  insertHead.run("conv-old", "idle", null, 100);
  insertHead.run("conv-new", "parked", null, 300);
  // Soft-deleted head: the tombstone check requires every pointer to be NULL.
  insertHead.run("conv-deleted", "deleted", 250, 250);

  const database = clientDrizzle(raw);
  for (const [index, entries] of [["a", "b", "c"], ["d"]].entries()) {
    database
      .insert(spConversationTerminalSegments)
      .values(
        terminalToRow({
          segmentId: `conv-new-seg-${index + 1}`,
          conversationId: "conv-new",
          logicalTurnId: `turn-${index + 1}`,
          executionId: `exec-conv-new-${index + 1}`,
          publicationKey: `pub-conv-new-${index + 1}`,
          previous: null,
          firstPosition: index === 0 ? "0" : "3",
          lastPosition: index === 0 ? "2" : "3",
          entries,
          contentHash: canonicalDigest(entries),
          createdAt: 1,
        }),
      )
      .run();
  }
  raw.close();
}

describe("storage schema surface", () => {
  it("exports all ten authority tables and the schema aggregate (TC-009)", async () => {
    roots.push(mkdtempSync(join(tmpdir(), "storage-client-")));
    const tableNames = Object.values(sqliteSchema).map((table) => getTableConfig(table).name);
    expect(tableNames.sort()).toEqual(
      [
        "sp_conversation_heads",
        "sp_conversation_checkpoints",
        "sp_conversation_public_segments",
        "sp_conversation_public_root_index",
        "sp_conversation_terminal_segments",
        "sp_conversation_command_receipts",
        "sp_execution_control",
        "sp_execution_journal_segments",
        "sp_execution_replay_segments",
        "sp_execution_objects",
      ].sort(),
    );

    const path = tempFile("schema.sqlite");
    await initializeFile(path);
    const binding = track(createSqliteWriterBinding(path));
    const rows = clientDrizzle(binding).select().from(sqliteSchema.spConversationHeads).all();
    expect(rows).toEqual([]);
  });

  it("derives thread summaries from authority tables (TC-011)", async () => {
    roots.push(mkdtempSync(join(tmpdir(), "storage-client-")));
    const path = tempFile("threads.sqlite");
    await initializeFile(path);
    seedAuthorityData(path);

    const binding = track(createSqliteWriterBinding(path));
    const client = createChatStorageClient(clientDrizzle(binding));

    const listed: ThreadSummary[] = client.threads.list();
    expect(listed.map((thread) => thread.id)).toEqual(["conv-new", "conv-old"]);
    expect(listed[0]).toEqual({ id: "conv-new", state: "parked", updatedAt: 300 });

    expect(client.threads.get("conv-deleted")).toEqual({
      id: "conv-deleted",
      state: "deleted",
      updatedAt: 250,
    });
    expect(client.threads.get("conv-missing")).toBeNull();

    const page: TranscriptPage = client.transcript.page("conv-new");
    expect(page.entries.map((entry) => [entry.position, entry.entry])).toEqual([
      [0, "a"],
      [1, "b"],
      [2, "c"],
      [3, "d"],
    ]);
    expect(page.nextAfter).toBeNull();

    const cursor = client.transcript.page("conv-new", { after: 0, limit: 2 });
    expect(cursor.entries.map((entry) => entry.position)).toEqual([1, 2]);
    expect(cursor.nextAfter).toBe(2);

    const exhausted = client.transcript.page("conv-new", { after: 2 });
    expect(exhausted.entries.map((entry) => entry.position)).toEqual([3]);
    expect(exhausted.nextAfter).toBeNull();

    const empty = client.transcript.page("conv-missing");
    expect(empty.entries).toEqual([]);
    expect(empty.nextAfter).toBeNull();

    const zeroLimit = client.transcript.page("conv-new", { limit: 0 });
    expect(zeroLimit.entries).toEqual([]);
    expect(zeroLimit.nextAfter).toBeNull();
  });

  it("serves identical reads through a reader binding (TC-011, TC-015)", async () => {
    roots.push(mkdtempSync(join(tmpdir(), "storage-client-")));
    const path = tempFile("reader.sqlite");
    await initializeFile(path);
    seedAuthorityData(path);

    const reader = openChatStorageReader(path);
    track(reader);
    const client = createChatStorageClient(reader.database);

    expect(client.threads.list().map((thread) => thread.id)).toEqual(["conv-new", "conv-old"]);
    expect(client.transcript.page("conv-new").entries).toHaveLength(4);

    reader.close();
    expect(() => client.threads.list()).toThrow();
  });
});
