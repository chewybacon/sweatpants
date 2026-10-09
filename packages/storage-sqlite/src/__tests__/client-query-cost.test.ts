import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { expect, it } from "vitest";
import { initializeSqliteStorage } from "../initialize.ts";
import { createChatStorageClient } from "../client.ts";
import { sqliteSchema } from "../schema.ts";

it("bounds thread and transcript pages and seeks deep cursors without scanning old history", () => {
  const queries: string[] = [];
  const db = new Database(":memory:", { verbose: (sql) => queries.push(String(sql)) });
  initializeSqliteStorage(db);
  const client = createChatStorageClient(drizzle(db, { schema: sqliteSchema }));
  try {
    for (const count of [100, 10000]) {
      db.prepare(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x < ?)
        INSERT OR IGNORE INTO sp_conversation_heads(conversation_id, revision, owner_epoch, state, updated_at)
        SELECT printf('thread-%05d',x),0,0,'idle',100 FROM n`).run(count);
      db.prepare(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x < ?)
        INSERT OR IGNORE INTO sp_conversation_terminal_segments
        (segment_id,conversation_id,logical_turn_id,execution_id,publication_key,first_position,last_position,entries_json,content_hash,created_at)
        SELECT 'segment-'||x,'conversation','turn','execution','publication-'||x,x*2,x*2+1,'["a","b"]','hash',1 FROM n`).run(
        count,
      );
      queries.length = 0;
      expect(client.threads.list()).toHaveLength(100);
      const first = client.threads.list({ limit: 3 });
      const next = client.threads.list({ limit: 3, before: first[2] });
      expect(new Set([...first, ...next].map((row) => row.id)).size).toBe(6);
      expect(
        client.threads
          .list({ limit: 3, before: { updatedAt: 100, id: "thread-00005" } })
          .map((row) => row.id),
      ).toEqual(["thread-00004", "thread-00003", "thread-00002"]);
      expect(client.threads.get("thread-00001")?.id).toBe("thread-00001");
      const page = client.transcript.page("conversation", { after: (count - 4) * 2, limit: 3 });
      expect(page.entries.map((row) => row.position)).toEqual([
        (count - 4) * 2 + 1,
        (count - 3) * 2,
        (count - 3) * 2 + 1,
      ]);
      expect(page.nextAfter).toBe((count - 3) * 2 + 1);
      expect(
        client.transcript
          .page("conversation", { after: count * 2, limit: 3 })
          .entries.map((row) => row.position),
      ).toEqual([count * 2 + 1]);
      expect(
        client.transcript.page("conversation", { limit: 3 }).entries.map((row) => row.position),
      ).toEqual([2, 3, 4]);
      expect(client.transcript.page("missing")).toEqual({ entries: [], nextAfter: null });
      const traced = [...queries];
      for (const query of traced) {
        const plan = db.prepare(`EXPLAIN QUERY PLAN ${query}`).all() as { detail: string }[];
        const details = plan.map((row) => row.detail).join("\n");
        expect(details, query).toMatch(/SEARCH/);
        expect(details, query).not.toMatch(/\bSCAN\b|USE TEMP B-TREE/);
        if (!query.includes("\"conversation_id\" = 'thread-00001'")) {
          expect(query, query).toMatch(/limit/i);
        }
        // Cursor predicates must be part of the index seek, not a residual filter.
        if (query.includes('"first_position" >')) {
          expect(details).toContain("first_position>?");
        }
        if (query.includes('"first_position" <=')) {
          expect(details).toContain("first_position<?");
        }
      }
      console.info(
        JSON.stringify({ scenario: "sqlite-reader-pages", rows: count, statements: traced.length }),
      );
    }
    for (const limit of [-1, 1001, NaN, Infinity, 1.5]) {
      expect(() => client.threads.list({ limit })).toThrow(RangeError);
      expect(() => client.transcript.page("conversation", { limit })).toThrow(RangeError);
    }
  } finally {
    db.close();
  }
});
