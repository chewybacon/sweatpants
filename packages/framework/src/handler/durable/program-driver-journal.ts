import type { Operation } from "effection";
import {
  createInMemoryDurableJournalAuthority,
  type CapabilityKeyring,
  type DurableJournalAuthorityService,
  type DurableSemanticRecord,
  type OpenDurableTaskRequest,
  type OperationOutcome,
  type ResolveOperationResult,
} from "@sweatpants/session-contract";

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
