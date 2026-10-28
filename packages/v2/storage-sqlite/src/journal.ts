import {
  createJournalBinding,
  createJournalRecord,
  type JournalBackend,
  type JournalRecords,
  type JournalRecord,
  type RequestRecord,
  type Accepted,
} from "@sweatpan.ts/durable";
import type { Serializer } from "@sweatpan.ts/storage";
import type { SqliteJournalOptions, SqliteJournalStore } from "./contracts.ts";

/**
 * Atomic colocated authority with exact request/receipt reads and append-only history.
 * Serializer resolution precedes locking. Native SQLite I/O is synchronous; the
 * portable transaction port supports yielding adapters. Caller owns the connection.
 * Experimental schema: no compatibility or migration of older databases.
 */
export function createSqliteJournalStore<R, Q, V, E, S = unknown, Y = never>(
  options: SqliteJournalOptions<Y>,
): SqliteJournalStore<R, Q, V, E, S, Y> {
  const { database: db, serialization, program, equals } = options;
  const id = options.id ?? crypto.randomUUID();
  db.exec(`
    CREATE TABLE IF NOT EXISTS sweatpants_executions (
      tree TEXT NOT NULL, id TEXT NOT NULL, format TEXT NOT NULL, payload BLOB NOT NULL,
      PRIMARY KEY (tree, id)
    );
    CREATE TABLE IF NOT EXISTS sweatpants_requests (
      tree TEXT NOT NULL, execution TEXT NOT NULL, request TEXT NOT NULL,
      format TEXT NOT NULL, payload BLOB NOT NULL, PRIMARY KEY (tree, execution, request)
    );
    CREATE TABLE IF NOT EXISTS sweatpants_history (
      tree TEXT NOT NULL, execution TEXT NOT NULL, sequence INTEGER NOT NULL,
      receipt TEXT NOT NULL, format TEXT NOT NULL, payload BLOB NOT NULL,
      PRIMARY KEY (tree, execution, sequence), UNIQUE (tree, execution, receipt)
    );
  `);
  const select = db.prepare(
    "SELECT format, payload FROM sweatpants_executions WHERE tree = ? AND id = ?",
  );
  const request = db.prepare(
    "SELECT format, payload FROM sweatpants_requests WHERE tree = ? AND execution = ? AND request = ?",
  );
  const receipt = db.prepare(
    "SELECT format, payload FROM sweatpants_history WHERE tree = ? AND execution = ? AND receipt = ?",
  );
  const history = db.prepare(
    "SELECT format, payload FROM sweatpants_history WHERE tree = ? AND execution = ? AND sequence >= ? AND sequence < ? ORDER BY sequence LIMIT ?",
  );
  const set = db.prepare(
    "INSERT INTO sweatpants_executions VALUES (?, ?, ?, ?) ON CONFLICT(tree,id) DO UPDATE SET format=excluded.format,payload=excluded.payload",
  );
  const setRequest = db.prepare(
    "INSERT INTO sweatpants_requests VALUES (?, ?, ?, ?, ?) ON CONFLICT(tree,execution,request) DO UPDATE SET format=excluded.format,payload=excluded.payload",
  );
  const append = db.prepare("INSERT INTO sweatpants_history VALUES (?, ?, ?, ?, ?, ?)");
  function decode(serializer: Serializer, row: Record<string, unknown>): unknown {
    if (row.format !== serializer.format) {
      throw new Error("Unsupported stored serialization format");
    }
    return serializer.decode(row.payload as Uint8Array);
  }
  const backend: JournalBackend<Y> = {
    *transact(work, publish) {
      const serializer = yield* serialization.resolve();
      db.exec("BEGIN IMMEDIATE");
      let committed = false;
      try {
        const cache = new Map<string, JournalRecord>();
        const requests = new Map<string, RequestRecord | undefined>();
        const rows: JournalRecords<Y> = {
          *get(key) {
            const cached = cache.get(key);
            if (cached) {
              return cached;
            }
            const row = select.get(id, key);
            // Private trusted storage boundary; domain types are bound by journal assembly.
            const value = row
              ? (decode(serializer, row) as JournalRecord)
              : key === id
                ? createJournalRecord(program)
                : undefined;
            if (value) {
              cache.set(key, value);
            }
            return value;
          },
          *set(key, value) {
            set.run(id, key, serializer.format, serializer.encode(value));
            cache.set(key, value);
          },
          *request(execution, requestId) {
            const key = JSON.stringify([execution, requestId]);
            if (requests.has(key)) {
              return requests.get(key);
            }
            const row = request.get(id, execution, requestId);
            const value = row ? (decode(serializer, row) as RequestRecord) : undefined;
            requests.set(key, value);
            return value;
          },
          *setRequest(execution, requestId, value) {
            setRequest.run(id, execution, requestId, serializer.format, serializer.encode(value));
            requests.set(JSON.stringify([execution, requestId]), value);
          },
          *accepted(execution, requestId) {
            const row = receipt.get(id, execution, requestId);
            return row
              ? (decode(serializer, row) as Accepted<unknown, unknown, unknown>)
              : undefined;
          },
          *append(execution, entry) {
            append.run(
              id,
              execution,
              entry.sequence,
              entry.receipt,
              serializer.format,
              serializer.encode(entry),
            );
          },
        };
        const result = yield* work(rows);
        db.exec("COMMIT");
        committed = true;
        publish?.();
        return result;
      } finally {
        if (!committed) {
          db.exec("ROLLBACK");
        }
      }
    },
    *history(execution, from, end, limit) {
      const serializer = yield* serialization.resolve();
      return history
        .all(id, execution, from, end, limit)
        .map((row) => decode(serializer, row) as Accepted<unknown, unknown, unknown>);
    },
  };
  return {
    id,
    open: () => createJournalBinding<R, Q, V, E, S, Y>({ program, equals }, backend, id),
  };
}
