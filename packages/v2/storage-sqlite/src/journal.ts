import {
  createJournalBinding,
  createJournalTransaction,
  createJournalRecord,
  type JournalBackend,
  type JournalRecords,
  type JournalRecord,
  type RequestRecord,
  type Accepted,
} from "@sweatpan.ts/durable";
import type { Serializer } from "@sweatpan.ts/storage";
import type { SqliteJournalOptions, SqliteJournalStore } from "./contracts.ts";

/** Step a nonsuspending operation inside a synchronous connection transaction. */
function runSynchronously<T>(operation: { [Symbol.iterator](): Iterator<unknown, T, unknown> }): T {
  const iterator = operation[Symbol.iterator]();
  const step = iterator.next();
  if (!step.done) {
    iterator.return?.();
    throw new Error("SQLite journal transactions cannot suspend");
  }
  return step.value;
}

/**
 * Atomic colocated authority with exact request/receipt reads and append-only history.
 * Serializer resolution precedes locking. The connection is synchronous, so journal work
 * inside a transaction must not suspend. Caller owns the connection.
 * Experimental schema: no compatibility or migration of older databases.
 */
export function createSqliteJournalStore<R, Q, V, E, S = unknown, Y = never>(
  options: SqliteJournalOptions<Y>,
): SqliteJournalStore<R, Q, V, E, S, Y> {
  const { connection: db, serialization, program, equals, revocations } = options;
  const id = options.id ?? crypto.randomUUID();
  db.exec(`
    CREATE TABLE IF NOT EXISTS sweatpants_activations (
      tree TEXT PRIMARY KEY, token TEXT NOT NULL
    );
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
  const readIntent = "SELECT token FROM sweatpants_activations WHERE tree = ?";
  const requestIntent =
    "INSERT INTO sweatpants_activations VALUES (?, ?) ON CONFLICT(tree) DO UPDATE SET token=excluded.token";
  const acknowledgeIntent = "DELETE FROM sweatpants_activations WHERE tree = ? AND token = ?";
  const select = "SELECT format, payload FROM sweatpants_executions WHERE tree = ? AND id = ?";
  const request =
    "SELECT format, payload FROM sweatpants_requests WHERE tree = ? AND execution = ? AND request = ?";
  const receipt =
    "SELECT format, payload FROM sweatpants_history WHERE tree = ? AND execution = ? AND receipt = ?";
  const history =
    "SELECT format, payload FROM sweatpants_history WHERE tree = ? AND execution = ? AND sequence >= ? AND sequence < ? ORDER BY sequence LIMIT ?";
  const set =
    "INSERT INTO sweatpants_executions VALUES (?, ?, ?, ?) ON CONFLICT(tree,id) DO UPDATE SET format=excluded.format,payload=excluded.payload";
  const setRequest =
    "INSERT INTO sweatpants_requests VALUES (?, ?, ?, ?, ?) ON CONFLICT(tree,execution,request) DO UPDATE SET format=excluded.format,payload=excluded.payload";
  const append = "INSERT INTO sweatpants_history VALUES (?, ?, ?, ?, ?, ?)";
  function decode(serializer: Serializer, row: Record<string, unknown>): unknown {
    if (row.format !== serializer.format) {
      throw new Error("Unsupported stored serialization format");
    }
    const payload = row.payload;
    return serializer.decode(
      payload instanceof ArrayBuffer ? new Uint8Array(payload) : (payload as Uint8Array),
    );
  }
  const backend: JournalBackend<Y> = {
    *transact(work) {
      const serializer = yield* serialization.resolve();
      let changed = false;
      const transaction = createJournalTransaction<Y>();
      try {
        const cache = new Map<string, JournalRecord>();
        const requests = new Map<string, RequestRecord | undefined>();
        const rows: JournalRecords<Y> = {
          *get(key) {
            const cached = cache.get(key);
            if (cached) {
              return cached;
            }
            const row = db.get(select, id, key);
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
          *set(key, value, activation) {
            if (activation !== "preserve") {
              changed = true;
            }
            db.run(set, id, key, serializer.format, serializer.encode(value));
            cache.set(key, value);
          },
          *request(execution, requestId) {
            const key = JSON.stringify([execution, requestId]);
            if (requests.has(key)) {
              return requests.get(key);
            }
            const row = db.get(request, id, execution, requestId);
            const value = row ? (decode(serializer, row) as RequestRecord) : undefined;
            requests.set(key, value);
            return value;
          },
          *setRequest(execution, requestId, value) {
            changed = true;
            db.run(
              setRequest,
              id,
              execution,
              requestId,
              serializer.format,
              serializer.encode(value),
            );
            requests.set(JSON.stringify([execution, requestId]), value);
          },
          *accepted(execution, requestId) {
            const row = db.get(receipt, id, execution, requestId);
            return row
              ? (decode(serializer, row) as Accepted<unknown, unknown, unknown>)
              : undefined;
          },
          *append(execution, entry) {
            changed = true;
            db.run(
              append,
              id,
              execution,
              entry.sequence,
              entry.receipt,
              serializer.format,
              serializer.encode(entry),
            );
          },
        };
        const result = db.transaction(() => {
          const value = runSynchronously(transaction.run(rows, work));
          if (changed) {
            db.run(requestIntent, id, crypto.randomUUID());
          }
          return value;
        });
        transaction.publish();
        return result;
      } finally {
        transaction.close();
      }
    },
    *history(execution, from, end, limit) {
      const serializer = yield* serialization.resolve();
      return db
        .all(history, id, execution, from, end, limit)
        .map((row) => decode(serializer, row) as Accepted<unknown, unknown, unknown>);
    },
  };
  return {
    id,
    activations: {
      *read() {
        const row = db.get(readIntent, id);
        return row ? { execution: id, token: row.token as string } : undefined;
      },
      *request() {
        const intent = { execution: id, token: crypto.randomUUID() };
        db.run(requestIntent, id, intent.token);
        return intent;
      },
      *acknowledge(observed) {
        if (observed.execution !== id) {
          throw new Error("Foreign activation intent");
        }
        return db.run(acknowledgeIntent, id, observed.token).changes !== 0;
      },
    },
    open: () =>
      createJournalBinding<R, Q, V, E, S, Y>({ program, equals, revocations }, backend, id),
  };
}
