import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { call, type Operation } from "effection";
import type { DurableKernel } from "@sweatpants/durable-storage-kernel";
import { createSqliteStorageComposition, type SqliteStorage } from "./repository.ts";
import { StorageError } from "./contract.ts";
import { sqliteMigrationFolder } from "./migrations.ts";
import { sqliteSchema, type SqliteSchema } from "./schema.ts";

export type SqliteFaultPoint =
  | "command-after-receipt"
  | "command-before-commit"
  | "execution-after-segment-insert"
  | "execution-before-commit";

type BetterSqliteStorageOptions = { migrate?: boolean; wal?: boolean };
type BetterSqliteStorageTestOptions = BetterSqliteStorageOptions & {
  faultInjection?: SqliteFaultPoint;
};

export function runSqliteMigrations(database: BetterSQLite3Database<SqliteSchema>): void {
  migrate(database, { migrationsFolder: sqliteMigrationFolder });
}

export interface BetterSqliteStorageHandle {
  readonly storage: SqliteStorage;
  readonly database: BetterSQLite3Database<SqliteSchema>;
  close(): Operation<void>;
}

export interface BetterSqliteStorageTestHandle extends BetterSqliteStorageHandle {
  /** Test-only access for backend kernel conformance. */
  readonly kernel: DurableKernel;
}

function* openBetterSqliteStorageInternal(
  path: string,
  options: BetterSqliteStorageOptions,
  faultInjection?: SqliteFaultPoint,
): Operation<BetterSqliteStorageTestHandle> {
  const client = new Database(path);
  client.defaultSafeIntegers(true);
  client.pragma("foreign_keys = ON");
  if (options.wal !== false) {
    client.pragma("journal_mode = WAL");
  }

  const database = drizzle(client, { schema: sqliteSchema });
  if (options.migrate === true) {
    runSqliteMigrations(database);
  }

  // Drizzle's better-sqlite3 transaction callback is synchronous, while the
  // repository capability is deliberately usable by async SQLite drivers. The
  // local composition therefore owns the async bridge and must also serialize
  // all callbacks before issuing BEGIN IMMEDIATE on its one client.
  let writeQueue = Promise.resolve();
  let armedFault = faultInjection;
  const composition = createSqliteStorageComposition({
    database,
    faultInjection: (point) => {
      if (armedFault === point) {
        armedFault = undefined;
        throw new StorageError("sqlite_transaction_failed", `Injected SQLite fault at ${point}`);
      }
    },
    transactions: {
      immediate<T>(body: (transaction: typeof database) => T | Promise<T>): Operation<T> {
        return call(async () => {
          const run = writeQueue.then(async () => {
            // better-sqlite3's drizzle.transaction() rejects a Promise-returning
            // callback. BEGIN IMMEDIATE keeps the writer lock while the async
            // repository body awaits only database work.
            try {
              client.exec("BEGIN IMMEDIATE");
              const result = await body(database);
              client.exec("COMMIT");
              return result;
            } catch (error) {
              try {
                client.exec("ROLLBACK");
              } catch {
                // The connection may already be closed or have no open transaction.
              }
              if (
                error instanceof StorageError ||
                (error !== null &&
                  typeof error === "object" &&
                  "code" in error &&
                  typeof error.code === "string")
              ) {
                throw error;
              }
              throw new StorageError("sqlite_transaction_failed", "SQLite transaction failed", {
                cause: error,
              });
            }
          });
          // Keep the queue alive after a failed transaction while preserving
          // the failure for the caller that owns this operation.
          writeQueue = run.then(
            () => undefined,
            () => undefined,
          );
          return await run;
        });
      },
    },
  });

  return {
    storage: composition.storage,
    kernel: composition.kernel,
    database,
    *close(): Operation<void> {
      client.close();
    },
  };
}

export function* openBetterSqliteStorage(
  path: string,
  options: BetterSqliteStorageOptions = {},
): Operation<BetterSqliteStorageHandle> {
  const handle = yield* openBetterSqliteStorageInternal(path, options);
  return {
    storage: handle.storage,
    database: handle.database,
    *close(): Operation<void> {
      yield* handle.close();
    },
  };
}

/** Test-only fault-injection composition. Not exported from the package root. */
export function* openBetterSqliteStorageForTest(
  path: string,
  options: BetterSqliteStorageTestOptions = {},
): Operation<BetterSqliteStorageTestHandle> {
  return yield* openBetterSqliteStorageInternal(path, options, options.faultInjection);
}
