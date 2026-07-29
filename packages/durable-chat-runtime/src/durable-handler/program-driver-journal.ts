import { type OperationOutcome } from "@sweatpants/durable-effects";

import type { Operation } from "effection";
import {
  createCapabilityKeyring,
  createStoredDurableJournalAuthority,
  type CapabilityKeyring,
  type DurableJournalAuthorityService,
  type DurableSemanticRecord,
  type DurableOperationState,
  type DurableTaskExecutionState,
  type DurableTaskRecoveryState,
  type OpenDurableTaskRequest,
  type ResolveOperationResult,
} from "@sweatpants/journal-authority";
import { createMemoryExecutionStore } from "@sweatpants/journal-authority/memory";
import type { ExecutionStore } from "@sweatpants/journal-authority/store";
import {
  createDurableSchemaRegistry,
  type DurableSchemaRegistry,
} from "@sweatpants/journal-authority/schema-registry";
import { type SchemaBinding } from "@sweatpants/foundation/schema";

import { foreignToolSchemaEntries } from "@sweatpants/tool-session/foreign";
import { programDriverChatEngineSchemaEntries } from "./program-driver-schema.ts";

/**
 * Builds the digest-keyed validator registry for one program-driver
 * deployment: the built-in chat-engine catalog merged with generated
 * tool/effect validator entries.
 */
export function programDriverSchemaRegistry(
  entries: Iterable<SchemaBinding> = [],
): ReturnType<typeof createDurableSchemaRegistry> {
  return createDurableSchemaRegistry([
    ...programDriverChatEngineSchemaEntries(),
    ...foreignToolSchemaEntries(),
    ...entries,
  ]);
}

/** Authority operations required by the framework without exposing signing capabilities. */
export interface ProgramDriverJournal {
  /** Narrow authority service installed only around one ProgramRuntime activation. */
  readonly authority: DurableJournalAuthorityService;
  /** Opens one pinned root task exactly once. */
  openTask(request: OpenDurableTaskRequest): Operation<void>;
  /** Reads authority-owned route/catalog state for process replacement. */
  executionState(sessionId: string, taskId: string): Operation<DurableTaskExecutionState>;
  /** Selects the runnable root or terminal result without downloading the journal. */
  recoveryState(sessionId: string, requestedTaskId?: string): Operation<DurableTaskRecoveryState>;
  /** Counts accepted root tasks without reading the journal. */
  rootTaskCount(sessionId: string): Operation<number>;
  /** Looks up one operation without exposing the journal. */
  operationState(
    sessionId: string,
    taskId: string,
    pullId: string,
  ): Operation<DurableOperationState>;
  /** Atomically fences the previous attachment and returns the next authority epoch. */
  replaceAttachment(
    sessionId: string,
    taskId: string,
    attachmentId: string,
  ): Operation<{ executionEpoch: number }>;
  /** Reads a parsed defensive semantic journal snapshot. */
  readJournal(sessionId: string, rootTaskId?: string): Operation<DurableSemanticRecord[]>;
  /** Idempotently records logical cancellation before pending work is resolved. */
  requestCancellation(sessionId: string, taskId: string, reason?: string): Operation<void>;
  /** Resolves an existing pull without exposing its private capability token. */
  resolvePending(request: {
    sessionId: string;
    taskId: string;
    pullId: string;
    audience: string;
    outcome: OperationOutcome;
  }): Operation<ResolveOperationResult>;
}

/** Composition-owned journal lookup. Implementations own persistence and shared identity. */
export interface ProgramDriverJournalStore {
  /** Opens the authority view for one durable conversation identity. */
  open(conversationId: string): Operation<ProgramDriverJournal>;
}

/** Configuration for a process-local development journal store. */
export interface ProgramDriverJournalStoreOptions {
  keyring: CapabilityKeyring;
  journalPrefix?: string;
  now?: () => number;
  /**
   * Digest-keyed Standard Schema validator registry for ownerless command
   * validation. Deployments merge the built-in chat-engine catalog with their
   * generated tool/effect catalogs.
   */
  schemaRegistry?: DurableSchemaRegistry;
  /** Bounded persistence shared by every authority opened through this composition. */
  executionStore?: ExecutionStore;
}

/**
 * Creates a process-local store for tests and development. It is intentionally
 * not a production durability implementation; the returned object owns all
 * authorities and their lifetime.
 */
/** Composition helper for local development and deterministic product tests. */
export function createDevelopmentProgramDriverJournalStore(options: {
  readonly audience: string;
  readonly secret: string;
}): ProgramDriverJournalStore {
  return createProgramDriverJournalStore({
    keyring: createCapabilityKeyring(options.audience, [
      { keyId: "development-v1", secret: options.secret },
    ]),
  });
}

export function createProgramDriverJournalStore(
  options: ProgramDriverJournalStoreOptions,
): ProgramDriverJournalStore {
  const executionStore = options.executionStore ?? createMemoryExecutionStore();

  return {
    *open(conversationId): Operation<ProgramDriverJournal> {
      const selected = createStoredDurableJournalAuthority(executionStore, {
        journalId: `${options.journalPrefix ?? "program-driver"}:${conversationId}`,
        journalIncarnation: "1",
        keyring: options.keyring,
        ...(options.now ? { now: options.now } : {}),
        schemaRegistry: options.schemaRegistry ?? programDriverSchemaRegistry(),
      });
      return {
        authority: selected,
        *openTask(request): Operation<void> {
          yield* selected.openTask(request);
        },
        *executionState(sessionId, taskId) {
          return yield* selected.taskExecutionState(sessionId, taskId);
        },
        *recoveryState(sessionId, requestedTaskId) {
          return yield* selected.taskRecoveryState(sessionId, requestedTaskId);
        },
        *rootTaskCount(sessionId) {
          return yield* selected.rootTaskCount(sessionId);
        },
        *operationState(sessionId, taskId, pullId) {
          return yield* selected.operationState(sessionId, taskId, pullId);
        },
        *replaceAttachment(sessionId, taskId, attachmentId) {
          const replaced = yield* selected.replaceAttachment(
            sessionId,
            taskId,
            attachmentId,
            "program-runtime",
          );
          return { executionEpoch: replaced.executionEpoch };
        },
        *readJournal(sessionId, rootTaskId): Operation<DurableSemanticRecord[]> {
          return rootTaskId
            ? yield* selected.readTaskJournal(sessionId, rootTaskId)
            : yield* selected.readJournal(sessionId);
        },
        *requestCancellation(sessionId, taskId, reason): Operation<void> {
          yield* selected.requestCancellation(sessionId, taskId, reason);
        },
        *resolvePending(request): Operation<ResolveOperationResult> {
          const capability = yield* selected.resolutionCapability(
            request.sessionId,
            request.taskId,
            request.pullId,
          );
          return yield* selected.resolve({
            capability,
            audience: request.audience,
            outcome: request.outcome,
          });
        },
      };
    },
  };
}
