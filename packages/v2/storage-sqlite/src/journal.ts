import {
  createJournalBinding,
  createJournalRecord,
  type JournalBackend,
  type JournalRecord,
  type Accepted,
} from "@sweatpan.ts/durable";
import type { Serializer } from "@sweatpan.ts/storage";
import type { SqliteJournalOptions, SqliteJournalStore } from "./contracts.ts";

/**
 * Node SQLite journal with atomic colocated ownership and append-only accepted rows.
 * Resolve serialization before locking; all eligibility, projection and writes run
 * synchronously under BEGIN IMMEDIATE. Encoding failures roll back the whole decision.
 * Caller owns connection disposal. This does not provide cross-database ownership.
 */
export function createSqliteJournalStore<R, Q, V, E, S = unknown, Y = never>(
  options: SqliteJournalOptions<Y>,
): SqliteJournalStore<R, Q, V, E, S, Y> {
  const { database: db, serialization, program, equals } = options;
  const id = options.id ?? crypto.randomUUID();
  db.exec(`
    CREATE TABLE IF NOT EXISTS sweatpants_meta (name TEXT PRIMARY KEY, version INTEGER NOT NULL);
    INSERT OR IGNORE INTO sweatpants_meta VALUES ('journal', 1);
    CREATE TABLE IF NOT EXISTS sweatpants_executions (
      tree TEXT NOT NULL, id TEXT NOT NULL, format TEXT NOT NULL, payload BLOB NOT NULL,
      PRIMARY KEY (tree, id)
    );
    CREATE TABLE IF NOT EXISTS sweatpants_history (
      tree TEXT NOT NULL, execution TEXT NOT NULL, sequence INTEGER NOT NULL,
      format TEXT NOT NULL, payload BLOB NOT NULL,
      PRIMARY KEY (tree, execution, sequence)
    );
  `);
  if (
    db.prepare("SELECT version FROM sweatpants_meta WHERE name = 'journal'").get()?.version !== 1
  ) {
    throw new Error("Unsupported SQLite journal schema");
  }
  const select = db.prepare(
    "SELECT format, payload FROM sweatpants_executions WHERE tree = ? AND id = ?",
  );
  const history = db.prepare(
    "SELECT format, payload FROM sweatpants_history WHERE tree = ? AND execution = ? ORDER BY sequence",
  );
  const insert = db.prepare("INSERT INTO sweatpants_executions VALUES (?, ?, ?, ?)");
  const update = db.prepare(
    "UPDATE sweatpants_executions SET format = ?, payload = ? WHERE tree = ? AND id = ?",
  );
  const append = db.prepare("INSERT INTO sweatpants_history VALUES (?, ?, ?, ?, ?)");
  function decode(serializer: Serializer, row: { format: unknown; payload: unknown }): unknown {
    if (row.format !== serializer.format) {
      throw new Error("Unsupported stored serialization format");
    }
    // The SQLite driver supplies BLOB bytes; domain data is trusted after one decode.
    return serializer.decode(row.payload as Uint8Array);
  }
  const backend: JournalBackend<Y> = {
    *transact(decide) {
      const serializer = yield* serialization.resolve();
      db.exec("BEGIN IMMEDIATE");
      try {
        const cache = new Map<string, JournalRecord>();
        const lengths = new Map<string, number>();
        const dirty = new Set<string>();
        const records = {
          get(key: string): JournalRecord | undefined {
            if (cache.has(key)) {
              return cache.get(key);
            }
            const row = select.get(id, key);
            if (!row) {
              if (key !== id) {
                return undefined;
              }
              const initial = createJournalRecord(program);
              cache.set(key, initial);
              dirty.add(key);
              return initial;
            }
            // Sole typed record boundary for this private, versioned schema.
            const value = decode(serializer, {
              format: row.format,
              payload: row.payload,
            }) as JournalRecord;
            const accepted = history
              .all(id, key)
              .map(
                (entry) =>
                  decode(serializer, { format: entry.format, payload: entry.payload }) as Accepted<
                    unknown,
                    unknown,
                    unknown
                  >,
              );
            value.snapshot = { ...value.snapshot, history: accepted };
            cache.set(key, value);
            lengths.set(key, accepted.length);
            return value;
          },
          set(key: string, value: JournalRecord) {
            cache.set(key, value);
            dirty.add(key);
          },
        };
        const result = decide(records);
        for (const key of dirty) {
          const value = cache.get(key)!;
          const { history: accepted, ...snapshot } = value.snapshot;
          const length = lengths.get(key) ?? 0;
          if (accepted.length < length) {
            throw new Error("Accepted history cannot shrink");
          }
          const bytes = serializer.encode({ ...value, snapshot });
          if (lengths.has(key)) {
            update.run(serializer.format, bytes, id, key);
          } else {
            insert.run(id, key, serializer.format, bytes);
          }
          for (let index = length; index < accepted.length; index++) {
            append.run(id, key, index, serializer.format, serializer.encode(accepted[index]));
          }
        }
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
  return {
    id,
    open: () => createJournalBinding<R, Q, V, E, S, Y>({ program, equals }, backend, id),
  };
}
