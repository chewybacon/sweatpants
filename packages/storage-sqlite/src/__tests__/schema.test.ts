import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { sql } from "drizzle-orm";
import { run } from "effection";
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

describe("SQLite spine schema", () => {
  it("creates the required indexes, checks, and exact pre-release domain shape", async () => {
    const path = await temporaryDatabase();
    const handle = await run(() => openBetterSqliteStorage(path, { migrate: true, wal: false }));

    try {
      const indexes = handle.database.all(
        sql`SELECT name, tbl_name FROM sqlite_master
            WHERE type = 'index' AND name NOT LIKE 'sqlite_%'
            ORDER BY name`,
      ) as Array<{ name: string; tbl_name: string }>;
      expect(indexes.map((index) => index.name)).toEqual([
        "sp_checkpoint_conversation_cause",
        "sp_checkpoint_conversation_created",
        "sp_execution_object_created",
        "sp_execution_object_scope_index",
        "sp_journal_task_range",
        "sp_journal_task_sequence",
        "sp_public_root_archive_ordinal",
        "sp_public_root_identity",
        "sp_public_root_segment",
        "sp_public_segment_conversation_position",
        "sp_receipt_retain_until",
        "sp_replay_task_range",
        "sp_replay_task_sequence",
        "sp_terminal_segment_conversation_position",
        "sp_terminal_segment_publication",
      ]);

      const domainSql = handle.database.all(
        sql`SELECT name, sql FROM sqlite_master
            WHERE type = 'table' AND name LIKE 'sp_%' ORDER BY name`,
      ) as Array<{ name: string; sql: string }>;
      expect(domainSql).toHaveLength(10);
      expect(domainSql.map((table) => table.name)).not.toContain("sp_stop_intents");
      expect(domainSql.some((table) => /response.*tail|tail.*response/i.test(table.name))).toBe(
        false,
      );
      expect(domainSql.every((table) => !/format.?version|version.?field/i.test(table.sql))).toBe(
        true,
      );
      expect(domainSql.find((table) => table.name === "sp_execution_objects")?.sql).toContain(
        "json_body",
      );
      expect(domainSql.find((table) => table.name === "sp_execution_objects")?.sql).toContain(
        "blob_body",
      );
      expect(domainSql.find((table) => table.name === "sp_conversation_heads")?.sql).toContain(
        "sp_heads_deleted_tombstone",
      );
    } finally {
      await run(() => handle.close());
    }
  });

  it("fails closed on a superseded pre-release schema without deleting it", async () => {
    const path = await temporaryDatabase();
    const legacy = new Database(path);
    legacy.exec(
      "CREATE TABLE sp_conversation_heads (legacy_marker TEXT NOT NULL); " +
        "INSERT INTO sp_conversation_heads (legacy_marker) VALUES ('preserve-me')",
    );
    legacy.close();

    await expect(
      run(() => openBetterSqliteStorage(path, { migrate: true, wal: false })),
    ).rejects.toMatchObject({ code: "durable_kernel_unavailable" });

    const inspection = new Database(path, { readonly: true, fileMustExist: true });
    try {
      expect(inspection.prepare("SELECT legacy_marker FROM sp_conversation_heads").get()).toEqual({
        legacy_marker: "preserve-me",
      });
    } finally {
      inspection.close();
    }
  });
});
