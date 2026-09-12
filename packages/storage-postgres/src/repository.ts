import { createKernelConversationStore } from "@sweatpants/history-store/repository";
import { createKernelExecutionStore } from "@sweatpants/journal-authority/store-repository";
import type { ConversationStore, ExecutionStore } from "./contract.ts";
import { createPostgresDurableKernel, type SweatpantsPostgresDatabase } from "./pg-kernel.ts";

export type { SweatpantsPostgresDatabase } from "./pg-kernel.ts";

export interface PostgresStorage {
  readonly conversationStore: ConversationStore;
  readonly executionStore: ExecutionStore;
}

export interface PostgresStorageComposition {
  readonly storage: PostgresStorage;
  readonly kernel: ReturnType<typeof createPostgresDurableKernel>;
}

/**
 * Compose shared semantic repositories over one Postgres transactional
 * kernel. Conversation and execution remain independent authority ports even
 * though they share a physical database and pool lifecycle.
 */
export function createPostgresStorageComposition(options: {
  database: SweatpantsPostgresDatabase;
  faultInjection?: (point: string) => void;
}): PostgresStorageComposition {
  const kernel = createPostgresDurableKernel(options);
  return {
    kernel,
    storage: {
      conversationStore: createKernelConversationStore(kernel),
      executionStore: createKernelExecutionStore(kernel),
    },
  };
}

export function createPostgresRepositories(options: {
  database: SweatpantsPostgresDatabase;
  faultInjection?: (point: string) => void;
}): PostgresStorage {
  return createPostgresStorageComposition(options).storage;
}
