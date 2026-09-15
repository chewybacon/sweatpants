import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import { call, type Operation } from "effection";
import { DurableKernelError, type DurableKernel } from "@sweatpants/durable-storage-kernel";
import { createSqliteStorageComposition, type SqliteStorage } from "./repository.ts";
import { SqliteBindingError } from "./contract.ts";
import { sqliteMigrationFolder } from "./migrations.ts";
import { sqliteSchema, type SqliteSchema } from "./schema.ts";

export type SqliteFaultPoint =
  | "command-after-receipt"
  | "command-before-commit"
  | "execution-after-segment-insert"
  | "execution-before-commit";

/** The `sp_` prefix is reserved for kernel-managed SQLite objects. */
const RESERVED_PREFIX = "sp_";
/** Cross-connection writer contention waits instead of failing (REQ-019). */
const BUSY_TIMEOUT_MS = 5000;

export type BetterSqliteBinding = Database.Database;

/** Re-exported for consumers that compose test bindings without a direct dep. */
export { Database as BetterSqliteDatabase };

export type BetterSqliteStorageOptions = {
  migrate?: boolean;
  wal?: boolean;
  /** Path mode only: open read-only. */
  readonly?: boolean;
  /** Caller-owned binding. Mutually exclusive with `path`. */
  database?: Database.Database;
};
type BetterSqliteStorageTestOptions = BetterSqliteStorageOptions & {
  faultInjection?: SqliteFaultPoint;
};

export function runSqliteMigrations(database: BetterSQLite3Database<SqliteSchema>): void {
  migrate(database, { migrationsFolder: sqliteMigrationFolder });
}

export interface BetterSqliteStorageHandle {
  readonly storage: SqliteStorage;
  readonly database: BetterSQLite3Database<SqliteSchema>;
  /** Closes only kernel-created bindings; caller-owned bindings stay open. */
  close(): Operation<void>;
}

export interface BetterSqliteStorageTestHandle extends BetterSqliteStorageHandle {
  /** Test-only access for backend kernel conformance. */
  readonly kernel: DurableKernel;
}

function bindingConflict(message: string): SqliteBindingError {
  return new SqliteBindingError("binding_conflict", message);
}

function bindingReadonly(): SqliteBindingError {
  return new SqliteBindingError(
    "binding_readonly",
    "SQLite storage requires a writable binding; readonly connections cannot hold authority",
  );
}

/**
 * Opens `path` with the full kernel writer discipline: safe integers, foreign
 * keys, WAL, and a busy timeout. Used by path mode and by applications that
 * want a pre-disciplined binding to hand back to `openBetterSqliteStorage`.
 */
export function createSqliteWriterBinding(path: string): Database.Database {
  const client = new Database(path);
  try {
    client.defaultSafeIntegers(true);
    // The busy handler must exist before any lock-taking pragma: a co-tenant
    // writer holding the database at creation time makes journal_mode wait
    // its turn instead of failing the binding outright.
    client.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
    client.pragma("foreign_keys = ON");
    client.pragma("journal_mode = WAL");
  } catch (error) {
    try {
      client.close();
    } catch {
      // The binding failed during discipline; nothing to preserve.
    }
    throw new DurableKernelError("durable_kernel_unavailable", "SQLite binding creation failed", {
      cause: error,
    });
  }
  return client;
}

/** Opens `path` read-only with reader discipline; the file must already exist. */
export function createSqliteReaderBinding(path: string): Database.Database {
  const client = new Database(path, { readonly: true, fileMustExist: true });
  try {
    client.defaultSafeIntegers(true);
    client.pragma("foreign_keys = ON");
    client.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
  } catch (error) {
    try {
      client.close();
    } catch {
      // The binding failed during discipline; nothing to preserve.
    }
    throw new DurableKernelError(
      "durable_kernel_unavailable",
      "SQLite reader binding creation failed",
      { cause: error },
    );
  }
  return client;
}

let managedNamespaceNamesCache: ReadonlySet<string> | undefined;

/** Every `sp_`-prefixed name the kernel schema and migrations manage. */
function managedNamespaceNames(): ReadonlySet<string> {
  if (!managedNamespaceNamesCache) {
    const names = new Set<string>();
    for (const table of Object.values(sqliteSchema)) {
      const config = getTableConfig(table);
      names.add(config.name);
      for (const index of config.indexes) {
        names.add(index.config.name);
      }
    }
    managedNamespaceNamesCache = names;
  }
  return managedNamespaceNamesCache;
}

/**
 * The `sp_` prefix is reserved. Objects outside the kernel's managed set
 * (tables, views, indexes, triggers) could collide with future kernel tables,
 * so opening fails closed before any migration or write.
 */
function assertReservedNamespace(client: Database.Database): void {
  const managed = managedNamespaceNames();
  const rows = client
    .prepare(
      `SELECT name, type FROM sqlite_master WHERE substr(name, 1, ${RESERVED_PREFIX.length}) = '${RESERVED_PREFIX}'`,
    )
    .all() as Array<{ name: string; type: string }>;
  const foreign = rows.filter((row) => !managed.has(row.name));
  if (foreign.length > 0) {
    const offending = foreign
      .map((row) => `'${row.name}' (${row.type})`)
      .slice(0, 5)
      .join(", ");
    throw new SqliteBindingError(
      "namespace_collision",
      `SQLite file contains object(s) in the reserved 'sp_' namespace that the storage kernel does not manage: ${offending}`,
    );
  }
}

function* openBetterSqliteStorageInternal(
  path: string | undefined,
  options: BetterSqliteStorageOptions,
  faultInjection?: SqliteFaultPoint,
): Operation<BetterSqliteStorageTestHandle> {
  const providedPath = typeof path === "string" && path.trim().length > 0;
  const providedDatabase = options.database !== undefined;
  if (providedPath && providedDatabase) {
    throw bindingConflict(
      "SQLite storage accepts either a path or a caller-owned database binding, not both",
    );
  }
  if (!providedPath && !providedDatabase) {
    throw bindingConflict("SQLite storage requires a path or a caller-owned database binding");
  }

  let owned: boolean;
  let client: Database.Database;
  if (providedDatabase) {
    owned = false;
    client = options.database as Database.Database;
    if (client.readonly || options.readonly === true) {
      // Fail closed without touching the caller's binding.
      throw bindingReadonly();
    }
  } else if (options.readonly === true) {
    owned = true;
    client = createSqliteReaderBinding(path as string);
  } else {
    owned = true;
    client = createSqliteWriterBinding(path as string);
  }

  let database: BetterSQLite3Database<SqliteSchema>;
  try {
    if (!owned) {
      // Idempotent discipline for handed-in bindings (REQ-003).
      client.defaultSafeIntegers(true);
      client.pragma("foreign_keys = ON");
      client.pragma("journal_mode = WAL");
      client.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
    }
    assertReservedNamespace(client);
    database = drizzle(client, { schema: sqliteSchema });
    if (options.migrate === true) {
      runSqliteMigrations(database);
    }
  } catch (error) {
    if (owned) {
      try {
        client.close();
      } catch {
        // Opening or migration already failed; preserve the original cause.
      }
    }
    if (error instanceof SqliteBindingError) {
      throw error;
    }
    throw new DurableKernelError("durable_kernel_unavailable", "SQLite storage open failed", {
      cause: error,
    });
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
        throw new DurableKernelError(
          "durable_kernel_transaction_failed",
          `Injected SQLite fault at ${point}`,
        );
      }
    },
    transactionRunner: {
      transaction<T>(body: (transaction: typeof database) => T | Promise<T>): Operation<T> {
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
                error instanceof SqliteBindingError ||
                error instanceof DurableKernelError ||
                (error !== null &&
                  typeof error === "object" &&
                  "code" in error &&
                  typeof error.code === "string")
              ) {
                throw error;
              }
              throw new DurableKernelError(
                "durable_kernel_transaction_failed",
                "SQLite transaction failed",
                { cause: error },
              );
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
      if (owned) {
        client.close();
      }
    },
  };
}

export function* openBetterSqliteStorage(
  path: string | undefined,
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
  path: string | undefined,
  options: BetterSqliteStorageTestOptions = {},
): Operation<BetterSqliteStorageTestHandle> {
  return yield* openBetterSqliteStorageInternal(path, options, options.faultInjection);
}
