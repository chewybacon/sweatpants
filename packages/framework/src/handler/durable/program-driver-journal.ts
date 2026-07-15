import type { Operation } from "effection";
import {
  createDurableSchemaRegistry,
  createInMemoryDurableJournalAuthority,
  type CapabilityKeyring,
  type DurableSchemaRegistryEntry,
  type DurableJournalAuthorityService,
  type DurableSchemaRegistry,
  type DurableSemanticRecord,
  type OpenDurableTaskRequest,
  type OperationOutcome,
  type ResolveOperationResult,
} from "@sweatpants/session-contract";

import { programDriverChatEngineSchemaEntries } from "./program-driver-chat-engine.ts";

/**
 * Builds the digest-keyed validator registry for one program-driver
 * deployment: the built-in chat-engine catalog merged with generated
 * tool/effect validator entries.
 */
export function programDriverSchemaRegistry(
  entries: Iterable<DurableSchemaRegistryEntry> = [],
): ReturnType<typeof createDurableSchemaRegistry> {
  return createDurableSchemaRegistry([...programDriverChatEngineSchemaEntries(), ...entries]);
}

/** Authority operations required by the framework without exposing signing capabilities. */
export interface ProgramDriverJournal {
  /** Narrow authority service installed only around one ProgramRuntime activation. */
  readonly authority: DurableJournalAuthorityService;
  /** Opens one pinned root task exactly once. */
  openTask(request: OpenDurableTaskRequest): Operation<void>;
  /** Reads a parsed defensive semantic journal snapshot. */
  readJournal(sessionId: string): Operation<DurableSemanticRecord[]>;
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
export interface InMemoryProgramDriverJournalStoreOptions {
  keyring: CapabilityKeyring;
  journalPrefix?: string;
  now?: () => number;
  /**
   * Digest-keyed Standard Schema validator registry for ownerless command
   * validation. Deployments merge the built-in chat-engine catalog with their
   * generated tool/effect catalogs.
   */
  schemaRegistry?: DurableSchemaRegistry;
}

/**
 * Creates a process-local store for tests and development. It is intentionally
 * not a production durability implementation; the returned object owns all
 * authorities and their lifetime.
 */
export function createInMemoryProgramDriverJournalStore(
  options: InMemoryProgramDriverJournalStoreOptions,
): ProgramDriverJournalStore {
  const authorities = new Map<string, ReturnType<typeof createInMemoryDurableJournalAuthority>>();

  return {
    *open(conversationId): Operation<ProgramDriverJournal> {
      let authority = authorities.get(conversationId);
      if (!authority) {
        authority = createInMemoryDurableJournalAuthority({
          journalId: `${options.journalPrefix ?? "framework-program-driver"}:${conversationId}`,
          journalIncarnation: "1",
          keyring: options.keyring,
          ...(options.now ? { now: options.now } : {}),
          schemaRegistry: options.schemaRegistry ?? programDriverSchemaRegistry(),
        });
        authorities.set(conversationId, authority);
      }
      const selected = authority;
      return {
        authority: selected,
        *openTask(request): Operation<void> {
          yield* selected.openTask(request);
        },
        *readJournal(sessionId): Operation<DurableSemanticRecord[]> {
          return selected.readJournal(sessionId);
        },
        *requestCancellation(sessionId, taskId, reason): Operation<void> {
          yield* selected.requestCancellation(sessionId, taskId, reason);
        },
        *resolvePending(request): Operation<ResolveOperationResult> {
          return yield* selected.resolve({
            capability: selected.resolutionCapability(
              request.sessionId,
              request.taskId,
              request.pullId,
            ),
            audience: request.audience,
            outcome: request.outcome,
          });
        },
      };
    },
  };
}
