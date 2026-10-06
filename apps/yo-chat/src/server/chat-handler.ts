import { createSqliteThreadMetadataStore } from "@/lib/sqlite-thread-metadata-store";
import { createPostgresThreadMetadataStore } from "@/lib/postgres-thread-metadata-store";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  createChatEndpoints,
  openChatStorageDatabase,
  type DurableChatHandlerConfig,
} from "@sweatpants/agent-host/server";
import { env } from "@/env";
import { setupYoChatModelProvider } from "./model-provider";
import { createYoChatStorageConfig } from "./storage-config";
import {
  configureThreadMetadataStore,
  createInMemoryThreadMetadataStore,
} from "@/lib/thread-metadata-store";
import { pickCard } from "../tools/pick-card/durable";
import { playTttTool } from "../tools/play-ttt/tool";

/** Expected composition failure for invalid workflow host configuration. */
export class ProgramDriverConfigurationError extends Error {
  readonly _tag = "ProgramDriverConfigurationError";
  readonly code = "PROGRAM_DRIVER_SECRET_REQUIRED";

  constructor() {
    super("PROGRAM_DRIVER_CAPABILITY_SECRET is required for durable chat execution");
    this.name = "ProgramDriverConfigurationError";
  }
}

/**
 * The yo-chat durable chat configuration. One name + secret derives journal
 * and projection-token keys; `programs` registers durable tool schemas.
 *
 * Binding inversion: yo-chat owns the SQLite binding (when the storage
 * selection is sqlite), configures thread metadata co-tenancy on it, and
 * hands it to the kernel. The kernel never closes a caller-owned binding.
 * Binding creation is fail-loud at composition: an unopenable path stops the
 * server before it serves traffic.
 */
export function yoChatConfig(): DurableChatHandlerConfig {
  const secret = env.PROGRAM_DRIVER_CAPABILITY_SECRET;
  if (!secret) {
    throw new ProgramDriverConfigurationError();
  }
  const selection = createYoChatStorageConfig();
  // The app owns its binding: it creates the parent directory and opens the
  // database itself, then hands the binding to the kernel.
  if (selection.kind === "sqlite" && "path" in selection) {
    mkdirSync(dirname(selection.path), { recursive: true });
  }
  const database = openChatStorageDatabase(selection);
  configureThreadMetadataStore(
    database
      ? createSqliteThreadMetadataStore(database)
      : selection.kind === "postgres"
        ? createPostgresThreadMetadataStore(selection.connectionString)
        : createInMemoryThreadMetadataStore(),
  );
  return {
    name: "yo-chat",
    secret,
    storage: database ? { kind: "sqlite", database } : selection,
    programs: [pickCard, playTttTool],
    setup: setupYoChatModelProvider,
    maxToolIterations: 10,
  };
}

/** Creates route-independent yo-chat endpoint capabilities. */
export function createYoChatEndpoints(): ReturnType<typeof createChatEndpoints> {
  return createChatEndpoints(yoChatConfig());
}
