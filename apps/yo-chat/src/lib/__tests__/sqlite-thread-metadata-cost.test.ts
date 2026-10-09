// @vitest-environment node
import { BetterSqliteDatabase as Database } from "@sweatpants/storage-sqlite/better-sqlite3";
import { expect, it } from "vitest";
import { createSqliteThreadMetadataStore } from "../sqlite-thread-metadata-store";

it("uses bounded indexed pages and point lookups for every metadata operation", () => {
  const queries: string[] = [];
  const db = new Database(":memory:", { verbose: (query) => queries.push(String(query)) });
  try {
    const store = createSqliteThreadMetadataStore(db);
    for (const count of [100, 10000]) {
      db.prepare(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x < ?)
        INSERT OR IGNORE INTO thread_metadata(id,namespace,title,created_at,updated_at,last_message_preview,message_count)
        SELECT printf('cost-%05d',x),'cost','Test',100,100,'',0 FROM n`).run(count);
      queries.length = 0;
      for (const namespace of [undefined, "cost", "missing"]) {
        const first = store.list(namespace, { limit: 10 });
        expect(first.length).toBe(namespace === "missing" ? 0 : 10);
        const deep = store.list(namespace, {
          limit: 10,
          before: { updatedAt: 100, id: "cost-00012" },
        });
        expect(deep.length).toBe(namespace === "missing" ? 0 : 10);
      }
      expect(store.get("cost-00001")?.id).toBe("cost-00001");
      expect(store.get("absent")).toBeNull();
      store.create({ id: "temporary", namespace: "cost" });
      expect(store.update("temporary", { title: "Updated" })?.title).toBe("Updated");
      expect(store.delete("temporary")).toBe(true);
      const traced = [...queries].filter((query) => /^(select|update|delete)/i.test(query));
      for (const query of traced) {
        const rows = db.prepare(`EXPLAIN QUERY PLAN ${query}`).all() as { detail: string }[];
        const details = rows.map((row) => row.detail).join("\n");
        // A first global page walks only its LIMIT entries in the ordering index.
        expect(details, query).not.toMatch(/USE TEMP B-TREE|SCAN thread_metadata(?! USING INDEX)/);
        if (/\blimit\b/i.test(query)) {
          expect(details, query).toMatch(/idx_thread_metadata_/);
        } else {
          expect(details, query).toMatch(/SEARCH .* USING INDEX sqlite_autoindex_thread_metadata/);
        }
      }
      console.info(
        JSON.stringify({ scenario: "sqlite-metadata", rows: count, statements: traced.length }),
      );
    }
  } finally {
    db.close();
  }
});
