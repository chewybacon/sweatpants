import type { DatabaseSync } from "node:sqlite";
import type { Operation } from "@standard-durability/core";

/** Application-local catalog and finite traversal for one designated sweep owner.
 * Recreate after connection reopen. No timer, lease, admission or retry policy.
 * A visit must return (including a classified failure) to advance the cursor;
 * interruption before checkpoint repeats the visit, not necessarily its effects. */
export function createPersistedSweep(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS consumer_catalog (id TEXT PRIMARY KEY, program TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS consumer_sweep (singleton INTEGER PRIMARY KEY CHECK(singleton=1), after_id TEXT, end_id TEXT);
    INSERT OR IGNORE INTO consumer_sweep VALUES (1, NULL, NULL);
  `);
  return {
    enroll(id: string, program: string) {
      db.prepare("INSERT OR IGNORE INTO consumer_catalog VALUES (?, ?)").run(id, program);
      if (
        db.prepare("SELECT program FROM consumer_catalog WHERE id=?").get(id)?.program !== program
      ) {
        throw new Error("Catalog binding is immutable");
      }
    },
    *tick<T, Y>(
      visit: (id: string, program: string) => Operation<T, Y>,
    ): Operation<T | { state: "wrapped" }, Y> {
      const checkpoint = db
        .prepare("SELECT after_id, end_id FROM consumer_sweep WHERE singleton=1")
        .get()!;
      const after = checkpoint.after_id as string | null;
      let end = checkpoint.end_id as string | null;
      if (end === null) {
        end = db.prepare("SELECT MAX(id) AS id FROM consumer_catalog").get()!.id as string | null;
        db.prepare("UPDATE consumer_sweep SET end_id=? WHERE singleton=1").run(end);
      }
      const row = db
        .prepare(
          "SELECT id, program FROM consumer_catalog WHERE (? IS NULL OR id > ?) AND id <= ? ORDER BY id LIMIT 1",
        )
        .get(after, after, end);
      if (!row) {
        db.prepare("UPDATE consumer_sweep SET after_id=NULL, end_id=NULL WHERE singleton=1").run();
        return { state: "wrapped" };
      }
      const id = row.id as string;
      const result = yield* visit(id, row.program as string);
      db.prepare("UPDATE consumer_sweep SET after_id=? WHERE singleton=1").run(id);
      return result;
    },
  };
}
