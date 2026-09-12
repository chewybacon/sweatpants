import { createKernelConversationStore } from "@sweatpants/history-store/repository";
import { createKernelExecutionStore } from "@sweatpants/journal-authority/store-repository";
import type { TransactionRunner } from "@sweatpants/durable-storage-kernel";
import type { ConversationStore, ExecutionStore } from "./contract.ts";
import {
  createSqliteDurableKernel,
  type SQLiteResultKind,
  type SweatpantsSqliteDatabase,
} from "./sqlite-kernel.ts";

export type {
  SQLiteResultKind,
  SweatpantsSqliteDatabase,
} from "./sqlite-kernel.ts";
export type { TransactionRunner } from "@sweatpants/durable-storage-kernel";

export interface SqliteStorage {
  readonly conversationStore: ConversationStore;
  readonly executionStore: ExecutionStore;
}

export interface SqliteStorageComposition {
  readonly storage: SqliteStorage;
  readonly kernel: ReturnType<typeof createSqliteDurableKernel>;
}

/**
 * Compose shared semantic repositories over one SQLite transactional kernel.
 * Conversation and execution remain independent authority ports even though
 * they share a physical database and connection lifecycle.
 */
export function createSqliteStorageComposition<
  TResultKind extends SQLiteResultKind,
  TRunResult,
>(options: {
  database: SweatpantsSqliteDatabase<TResultKind, TRunResult>;
  transactionRunner: TransactionRunner<
    SweatpantsSqliteDatabase<TResultKind, TRunResult>
  >;
  faultInjection?: (point: string) => void;
}): SqliteStorageComposition {
  const kernel = createSqliteDurableKernel(options);
  return {
    kernel,
    storage: {
      conversationStore: createKernelConversationStore(kernel),
      executionStore: createKernelExecutionStore(kernel),
    },
  };
}

export function createSqliteRepositories<
  TResultKind extends SQLiteResultKind,
  TRunResult,
>(options: {
  database: SweatpantsSqliteDatabase<TResultKind, TRunResult>;
  transactionRunner: TransactionRunner<
    SweatpantsSqliteDatabase<TResultKind, TRunResult>
  >;
  faultInjection?: (point: string) => void;
}): SqliteStorage {
  return createSqliteStorageComposition(options).storage;
}
