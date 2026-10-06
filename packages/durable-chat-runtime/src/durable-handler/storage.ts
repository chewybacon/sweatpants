import { fileURLToPath } from "node:url";
import type { Operation, Scope } from "effection";
import { z } from "zod";
import type Database from "better-sqlite3";
import { createMemoryConversationStore } from "@sweatpants/history-store/memory";
import { installConversationStore } from "@sweatpants/history-store/port";
import type { ConversationStore } from "@sweatpants/history-store/contract";
import { createMemoryExecutionStore } from "@sweatpants/journal-authority/memory";
import type { ExecutionStore } from "@sweatpants/journal-authority/store";
import { installExecutionStore } from "@sweatpants/journal-authority/api";

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
      readonly kind: "postgres";
      readonly connectionString: string;
      readonly maxPoolSize?: number;
      readonly synchronousCommit?: "on" | "off";
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
    SWEATPANTS_PG_URL: z.string().optional(),
  })
  .superRefine((value, context) => {
    const selector = value.SWEATPANTS_STORAGE;
    if (selector !== undefined && selector !== "memory" && selector !== "postgres") {
      context.addIssue({
        code: "custom",
        path: ["SWEATPANTS_STORAGE"],
        message:
          'SWEATPANTS_STORAGE only accepts "memory" or "postgres"; leave it unset to use SQLite (the default)',
      });
    }
    if (value.SWEATPANTS_DB_PATH !== undefined && value.SWEATPANTS_DB_PATH.trim().length === 0) {
      context.addIssue({
        code: "custom",
        path: ["SWEATPANTS_DB_PATH"],
        message: "SWEATPANTS_DB_PATH must not be empty",
      });
    }
    if (value.SWEATPANTS_PG_URL !== undefined && value.SWEATPANTS_PG_URL.trim().length === 0) {
      context.addIssue({
        code: "custom",
        path: ["SWEATPANTS_PG_URL"],
        message: "SWEATPANTS_PG_URL must not be empty",
      });
    }
    if (selector === "postgres" && value.SWEATPANTS_DB_PATH !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["SWEATPANTS_STORAGE"],
        message: "SWEATPANTS_STORAGE=postgres cannot be combined with SWEATPANTS_DB_PATH",
      });
    }
    if (selector === "memory" && value.SWEATPANTS_DB_PATH !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["SWEATPANTS_STORAGE"],
        message: "SWEATPANTS_STORAGE=memory cannot be combined with SWEATPANTS_DB_PATH",
      });
    }
    if (selector === "memory" && value.SWEATPANTS_PG_URL !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["SWEATPANTS_STORAGE"],
        message: "SWEATPANTS_STORAGE=memory cannot be combined with SWEATPANTS_PG_URL",
      });
    }
  });

/**
 * Resolves authority storage from the standard sweatpants environment
 * contract:
 *
 * - unset selector: SQLite at `SWEATPANTS_DB_PATH` or `defaultPath`
 * - `SWEATPANTS_STORAGE=memory`: explicit non-durable in-memory storage
 * - `SWEATPANTS_STORAGE=postgres`: Postgres at `SWEATPANTS_PG_URL` or localhost:5432
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
    ...(source["SWEATPANTS_PG_URL"] !== undefined
      ? { SWEATPANTS_PG_URL: source["SWEATPANTS_PG_URL"] }
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
  if (parsed.SWEATPANTS_STORAGE === "postgres") {
    return {
      kind: "postgres",
      connectionString:
        parsed.SWEATPANTS_PG_URL ?? "postgres://postgres:postgres@localhost:5432/postgres",
      ...profile,
    };
  }
  const path =
    parsed.SWEATPANTS_DB_PATH ??
    (typeof options.defaultPath === "string"
      ? options.defaultPath
      : fileURLToPath(options.defaultPath));
  return { kind: "sqlite", path, ...profile };
}

export function resolveImmediateChatStorage(
  config: Exclude<ChatStorageConfig, { readonly kind: "sqlite" } | { readonly kind: "postgres" }>,
): ResolvedChatStorage {
  const drivers = resolveChatStorageDrivers(config);
  if (!drivers) {
    throw new TypeError(
      `Immediate chat storage does not support the "${config.kind}" backend; use scoped resolution`,
    );
  }
  return drivers;
}

/**
 * Resolves a storage selection into driver instances WITHOUT opening a
 * backend: memory and caller-owned stores are the drivers themselves.
 */
export function resolveChatStorageDrivers(config: ChatStorageConfig): ResolvedChatStorage | null {
  if (config.kind === "custom") {
    return {
      conversationStore: config.conversationStore,
      executionStore: config.executionStore,
      profile: config.profile,
    };
  }
  if (config.kind === "memory") {
    return {
      conversationStore: createMemoryConversationStore(),
      executionStore: createMemoryExecutionStore(),
      profile: config.profile,
    };
  }
  return null;
}

/**
 * Registers the resolved storage drivers into the current scope's ports.
 * This is the single registration call request and turn scopes make;
 * drivers were selected by {@link installChatStorage} or the caller.
 */
export function* installChatStorageDrivers(storage: ResolvedChatStorage): Operation<void> {
  yield* installConversationStore(storage.conversationStore);
  yield* installExecutionStore(storage.executionStore);
}

/**
 * The one composition point for chat storage: opens whichever backend the
 * configuration selects, keeps its handle alive on the application scope,
 * and returns the driver bundle. Consumers never see backend identity —
 * they resolve stores through the ports via `installChatStorageDrivers`.
 */
export async function chatStorageForScope(
  config: ChatStorageConfig,
  applicationScope: Scope,
): Promise<ResolvedChatStorage> {
  if (config.kind === "custom" || config.kind === "memory") {
    return resolveImmediateChatStorage(config);
  }
  // Node backends are imported only after an explicit backend selection.
  const { openScopedPostgresChatStorage, openScopedSqliteChatStorage } =
    await import("./storage-node.ts");
  if (config.kind === "postgres") {
    return openScopedPostgresChatStorage(config, applicationScope);
  }
  assertChatSqliteStorageVariant(config);
  return openScopedSqliteChatStorage(config, applicationScope);
}
