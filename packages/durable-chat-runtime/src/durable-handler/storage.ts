import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { call, createScope, ensure, suspend, type Operation, type Scope } from "effection";
import { z } from "zod";
import type Database from "better-sqlite3";
import { createMemoryConversationStore } from "@sweatpants/history-store/memory";
import type { ConversationStore } from "@sweatpants/history-store/contract";
import { createMemoryExecutionStore } from "@sweatpants/journal-authority/memory";
import type { ExecutionStore } from "@sweatpants/journal-authority/store";
import {
  createSqliteWriterBinding,
  openBetterSqliteStorage,
} from "@sweatpants/storage-sqlite/better-sqlite3";

export type ChatStorageConfig =
  | {
      readonly kind: "sqlite";
      readonly path: string;
      readonly profile?: "low" | "default";
    }
  | {
      readonly kind: "sqlite";
      /** Caller-owned binding; the kernel never closes it. */
      readonly database: Database.Database;
      readonly profile?: "low" | "default";
    }
  | {
      readonly kind: "memory";
      readonly profile?: "low" | "default";
    }
  | {
      readonly kind: "custom";
      readonly conversationStore: ConversationStore;
      readonly executionStore: ExecutionStore;
      readonly profile?: "low" | "default";
    };

/**
 * Validates the sqlite variant: exactly one of `path` or `database`.
 * Fails loud at composition time, matching the established configuration
 * error style.
 */
export function assertChatSqliteStorageVariant(
  variant: Extract<ChatStorageConfig, { readonly kind: "sqlite" }>,
): void {
  const hasPath =
    "path" in variant && typeof variant.path === "string" && variant.path.trim().length > 0;
  const hasDatabase = "database" in variant && variant.database !== undefined;
  if (hasPath && hasDatabase) {
    throw new TypeError(
      "Durable chat storage configuration accepts either a database binding or a path, not both",
    );
  }
  if (!hasPath && !hasDatabase) {
    throw new TypeError(
      "Durable chat storage configuration requires a SQLite path or a database binding",
    );
  }
}

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

export interface ResolvedChatStorage {
  readonly conversationStore: ConversationStore;
  readonly executionStore: ExecutionStore;
  readonly profile?: "low" | "default";
}

/** Options for {@link chatStorageFromEnv}. */
export interface ChatStorageEnvOptions {
  /**
   * SQLite database file used when the environment selects nothing.
   * Accepts a filesystem path or a `file:` URL, for example
   * `new URL("../../.data/my-app.sqlite", import.meta.url)`.
   */
  readonly defaultPath: string | URL;
  /** Environment map to read; defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Checkpoint sizing profile applied to whichever storage kind is selected. */
  readonly profile?: "low" | "default";
}

const storageEnvironmentSchema = z
  .object({
    SWEATPANTS_STORAGE: z.string().optional(),
    SWEATPANTS_DB_PATH: z.string().optional(),
  })
  .superRefine((value, context) => {
    if (value.SWEATPANTS_STORAGE !== undefined && value.SWEATPANTS_STORAGE !== "memory") {
      context.addIssue({
        code: "custom",
        path: ["SWEATPANTS_STORAGE"],
        message:
          'SWEATPANTS_STORAGE only accepts "memory"; leave it unset to use SQLite (the default)',
      });
    }
    if (value.SWEATPANTS_DB_PATH !== undefined && value.SWEATPANTS_DB_PATH.trim().length === 0) {
      context.addIssue({
        code: "custom",
        path: ["SWEATPANTS_DB_PATH"],
        message: "SWEATPANTS_DB_PATH must not be empty",
      });
    }
    if (value.SWEATPANTS_STORAGE === "memory" && value.SWEATPANTS_DB_PATH !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["SWEATPANTS_STORAGE"],
        message: "SWEATPANTS_STORAGE=memory cannot be combined with SWEATPANTS_DB_PATH",
      });
    }
  });

/**
 * Resolves authority storage from the standard sweatpants environment
 * contract:
 *
 * - unset selector: SQLite at `SWEATPANTS_DB_PATH` or `defaultPath`
 * - `SWEATPANTS_STORAGE=memory`: explicit non-durable in-memory storage
 * - anything contradictory or unrecognized: a thrown configuration error
 */
export function chatStorageFromEnv(options: ChatStorageEnvOptions): ChatStorageConfig {
  const source = options.env ?? process.env;
  const result = storageEnvironmentSchema.safeParse({
    ...(source["SWEATPANTS_STORAGE"] !== undefined
      ? { SWEATPANTS_STORAGE: source["SWEATPANTS_STORAGE"] }
      : {}),
    ...(source["SWEATPANTS_DB_PATH"] !== undefined
      ? { SWEATPANTS_DB_PATH: source["SWEATPANTS_DB_PATH"] }
      : {}),
  });
  if (!result.success) {
    throw new TypeError(
      `Invalid storage environment: ${result.error.issues.map((issue) => issue.message).join("; ")}`,
    );
  }
  const parsed = result.data;
  const profile = options.profile ? { profile: options.profile } : {};
  if (parsed.SWEATPANTS_STORAGE === "memory") {
    return { kind: "memory", ...profile };
  }
  const path =
    parsed.SWEATPANTS_DB_PATH ??
    (typeof options.defaultPath === "string"
      ? options.defaultPath
      : fileURLToPath(options.defaultPath));
  return { kind: "sqlite", path, ...profile };
}

export function resolveImmediateChatStorage(
  config: Exclude<ChatStorageConfig, { readonly kind: "sqlite" }>,
): ResolvedChatStorage {
  if (config.kind === "custom") {
    return {
      conversationStore: config.conversationStore,
      executionStore: config.executionStore,
      ...(config.profile ? { profile: config.profile } : {}),
    };
  }
  return {
    conversationStore: createMemoryConversationStore(),
    executionStore: createMemoryExecutionStore(),
    ...(config.profile ? { profile: config.profile } : {}),
  };
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
          migrate: true,
          wal: true,
          ...(databaseBinding ? { database: databaseBinding } : {}),
        });
        // Caller-owned bindings are closed by their owner (REQ-005).
        if (!databaseMode) {
          yield* ensure(() => handle.close());
        }
        settled = true;
        resolve({
          conversationStore: handle.storage.conversationStore,
          executionStore: handle.storage.executionStore,
          ...(config.profile ? { profile: config.profile } : {}),
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
