import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteJournalStore, v8Serializer } from "@sweatpan.ts/storage-sqlite";
import type { JournalBindingOptions } from "@sweatpan.ts/durable";
import type { Operation } from "@standard-durability/core";
import type { Serializer } from "@sweatpan.ts/storage";

/** Temporary real SQLite connections for in-process hosted journeys; caller must close. */
export function createSqliteJournalRig<R, Q, V, E, S = unknown, Y = never>(
  options: JournalBindingOptions & { serialization?: { resolve(): Operation<Serializer, Y> } },
) {
  const directory = mkdtempSync(join(tmpdir(), "sweatpants-journal-"));
  const path = join(directory, "journal.sqlite");
  const id = crypto.randomUUID();
  const connections = new Set<DatabaseSync>();
  function connect() {
    const database = new DatabaseSync(path);
    connections.add(database);
    const store = createSqliteJournalStore<R, Q, V, E, S, Y>({
      ...options,
      id,
      database,
      serialization: options.serialization ?? {
        *resolve() {
          return v8Serializer;
        },
      },
    });
    return { database, store };
  }
  let current = connect();
  return {
    id,
    open: () => current.store.open(),
    /** Separate connection to the same authority, for racing an externally controlled write. */
    connect: () => connect().store.open(),
    /** Close the current connection and recreate the entire store/binding assembly. */
    reopen() {
      current.database.close();
      connections.delete(current.database);
      current = connect();
      return current.store.open();
    },
    close() {
      for (const db of connections) {
        db.close();
      }
      connections.clear();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
