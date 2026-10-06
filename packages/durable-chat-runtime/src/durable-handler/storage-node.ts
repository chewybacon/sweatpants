import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { call, createScope, ensure, suspend, type Operation, type Scope } from "effection";
import type Database from "better-sqlite3";
import {
  createSqliteWriterBinding,
  openBetterSqliteStorage,
} from "@sweatpants/storage-sqlite/better-sqlite3";
import { openPostgresStorage } from "@sweatpants/storage-postgres/pg-binding";
import {
  assertChatSqliteStorageVariant,
  type ChatStorageConfig,
  type ResolvedChatStorage,
} from "./storage.ts";

/**
 * Converts a resolved storage selection into a caller-owned binding.
 * Returns `null` for non-sqlite selections; returns a handed-in binding
 * unchanged; opens and disciplines a writer binding for path selections.
 */
export function openChatStorageDatabase(selection: ChatStorageConfig): Database.Database | null {
  if (selection.kind !== "sqlite") {
    return null;
  }
  assertChatSqliteStorageVariant(selection);
  if ("database" in selection) {
    return selection.database;
  }
  return createSqliteWriterBinding(selection.path);
}

function isHaltedError(error: unknown): boolean {
  return error instanceof Error && error.message === "halted";
}

/**
 * Opens one SQLite composition in a child of the application scope. The child
 * remains suspended until its parent closes, at which point the handle's
 * finalizer closes the database connection.
 */
export function openScopedSqliteChatStorage(
  config: Extract<ChatStorageConfig, { readonly kind: "sqlite" }>,
  applicationScope: Scope,
): Promise<ResolvedChatStorage> {
  const databaseMode = "database" in config;
  const databasePath = databaseMode ? undefined : config.path;
  const databaseBinding = databaseMode ? config.database : undefined;
  const [ownerScope, destroyOwnerScope] = createScope(applicationScope);
  let settled = false;

  return new Promise<ResolvedChatStorage>((resolve, reject) => {
    ownerScope
      .run(function* (): Operation<void> {
        if (!databaseMode) {
          yield* call(() => mkdir(dirname(config.path), { recursive: true }));
        }
        const handle = yield* openBetterSqliteStorage(databasePath, {
          initialize: true,
          wal: true,
          database: databaseBinding,
        });
        // Caller-owned bindings are closed by their owner (REQ-005).
        if (!databaseMode) {
          yield* ensure(() => handle.close());
        }
        settled = true;
        resolve({
          conversationStore: handle.storage.conversationStore,
          executionStore: handle.storage.executionStore,
          profile: config.profile,
        });
        yield* suspend();
      })
      .catch((error: unknown) => {
        if (!settled) {
          settled = true;
          reject(error);
          void destroyOwnerScope().catch(() => undefined);
        } else if (!isHaltedError(error)) {
          console.error("[ChatStorage] SQLite owner failed", { error });
        }
      });
  });
}

/**
 * Opens one Postgres composition in a child of the application scope. The
 * pool is owned by the child scope and closed when the application scope
 * closes; caller-owned pools and databases are closed by their owner.
 */
export function openScopedPostgresChatStorage(
  config: Extract<ChatStorageConfig, { readonly kind: "postgres" }>,
  applicationScope: Scope,
): Promise<ResolvedChatStorage> {
  const [ownerScope, destroyOwnerScope] = createScope(applicationScope);
  let settled = false;

  return new Promise<ResolvedChatStorage>((resolve, reject) => {
    ownerScope
      .run(function* (): Operation<void> {
        const handle = yield* call(() =>
          openPostgresStorage({
            connectionString: config.connectionString,
            initialize: true,
            maxPoolSize: config.maxPoolSize,
            synchronousCommit: config.synchronousCommit,
          }),
        );
        yield* ensure(() => handle.close());
        settled = true;
        resolve({
          conversationStore: handle.storage.conversationStore,
          executionStore: handle.storage.executionStore,
          profile: config.profile,
        });
        yield* suspend();
      })
      .catch((error: unknown) => {
        if (!settled) {
          settled = true;
          reject(error);
          void destroyOwnerScope().catch(() => undefined);
        } else if (!isHaltedError(error)) {
          console.error("[ChatStorage] Postgres owner failed", { error });
        }
      });
  });
}
