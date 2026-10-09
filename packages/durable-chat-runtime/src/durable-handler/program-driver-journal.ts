import { type OperationOutcome } from "@sweatpants/durable-effects";
import { scoped, type Operation } from "effection";
import {
  createCapabilityKeyring,
  createJournal,
  installJournal,
  useJournal,
  type Journal,
  type AcceptAssistantPartialRequest,
  type AcceptAssistantPartialResult,
  type AcceptPullPreparationRequest,
  type AcceptPullPreparationResult,
  type AuthorizeModelDispatchRequest,
  type AuthorizeModelDispatchResult,
  type CapabilityKeyring,
  type DurableOperationState,
  type DurableSemanticRecord,
  type DurableTaskExecutionState,
  type DurableTaskRecoveryState,
  type ModelContextPreparedFact,
  type OpenDurableTaskRequest,
  type PrivateSegmentTarget,
  type ResolveOperationResult,
  type ValidateElicitResponseRequest,
  type ValidateElicitResponseResult,
} from "@sweatpants/journal-authority";
import { ExecutionStorePort, installExecutionStore } from "@sweatpants/journal-authority/api";
import type { ExecutionStore } from "@sweatpants/journal-authority/store";
import {
  createDurableSchemaRegistry,
  type DurableSchemaRegistry,
} from "@sweatpants/journal-authority/schema-registry";
import { type SchemaBinding } from "@sweatpants/foundation/schema";

import { ephemeralToolSchemaEntries } from "@sweatpants/tool-session/ephemeral";
import { programDriverChatEngineSchemaEntries } from "./program-driver-schema.ts";

export function programDriverSchemaRegistry(
  entries: Iterable<SchemaBinding> = [],
): ReturnType<typeof createDurableSchemaRegistry> {
  return createDurableSchemaRegistry([
    ...programDriverChatEngineSchemaEntries(),
    ...ephemeralToolSchemaEntries(),
    ...entries,
  ]);
}

/** Conversation-scoped composition and narrow host operations. */
export interface ProgramDriverJournal {
  advance: Journal["advance"];
  query: Journal["query"];
  openTask(request: OpenDurableTaskRequest): Operation<{ readonly programCapability: string }>;
  executionState(sessionId: string, taskId: string): Operation<DurableTaskExecutionState>;
  recoveryState(sessionId: string, requestedTaskId?: string): Operation<DurableTaskRecoveryState>;
  rootTaskCount(sessionId: string): Operation<number>;
  operationState(
    sessionId: string,
    taskId: string,
    pullId: string,
  ): Operation<DurableOperationState>;
  readJournal(sessionId: string, rootTaskId?: string): Operation<DurableSemanticRecord[]>;
  requestCancellation(
    sessionId: string,
    taskId: string,
    reason?: string,
    commandId?: string,
  ): Operation<void>;
  resolvePending(request: {
    sessionId: string;
    taskId: string;
    pullId: string;
    audience: string;
    outcome: OperationOutcome;
  }): Operation<ResolveOperationResult>;
  validateElicitResponse(
    request: ValidateElicitResponseRequest,
  ): Operation<ValidateElicitResponseResult>;
  pullPreparation(
    sessionId: string,
    taskId: string,
    pullId: string,
  ): Operation<ModelContextPreparedFact | null>;
  acceptPullPreparation(
    request: AcceptPullPreparationRequest,
  ): Operation<AcceptPullPreparationResult>;
  authorizeModelDispatch(
    request: AuthorizeModelDispatchRequest,
  ): Operation<AuthorizeModelDispatchResult>;
  acceptAssistantPartial(
    request: AcceptAssistantPartialRequest,
  ): Operation<AcceptAssistantPartialResult>;
}

export interface ProgramDriverJournalStore {
  /** Own one installed journal for the operation and its child tasks.
   * Consume journal-dependent operations inside this lifetime; deferred work
   * selects its own journal when it runs.
   */
  withJournal<T>(
    conversationId: string,
    operation: (journal: ProgramDriverJournal) => Operation<T>,
  ): Operation<T>;
}

export interface ProgramDriverJournalStoreOptions {
  keyring: CapabilityKeyring;
  journalPrefix?: string;
  now?: () => number;
  schemaRegistry?: DurableSchemaRegistry;
  executionStore: ExecutionStore;
  privateSegmentTarget?: PrivateSegmentTarget;
  /** Named by the REQ-012 reset failure when stored data cannot be parsed. */
  dataDirectory?: string;
}

export function createDevelopmentProgramDriverJournalStore(options: {
  readonly audience: string;
  readonly secret: string;
  readonly executionStore: ExecutionStore;
}): ProgramDriverJournalStore {
  return createProgramDriverJournalStore({
    keyring: createCapabilityKeyring(options.audience, [
      { keyId: "development-v1", secret: options.secret },
    ]),
    executionStore: options.executionStore,
  });
}

export function createProgramDriverJournalStore(
  options: ProgramDriverJournalStoreOptions,
): ProgramDriverJournalStore {
  const executionStore = options.executionStore;

  return {
    *withJournal<T>(
      conversationId: string,
      operation: (journal: ProgramDriverJournal) => Operation<T>,
    ): Operation<T> {
      return yield* scoped(function* () {
        const authorityOptions = {
          journalId: `${options.journalPrefix ?? "program-driver"}:${conversationId}`,
          journalIncarnation: "1",
          keyring: options.keyring,
          now: options.now,
          privateSegmentTarget: options.privateSegmentTarget,
          dataDirectory: options.dataDirectory || undefined,
          schemaRegistry: options.schemaRegistry ?? programDriverSchemaRegistry(),
        };

        yield* installExecutionStore(executionStore);
        const owned = yield* createJournal(ExecutionStorePort.api.operations, authorityOptions);
        yield* installJournal(owned);
        const operations = yield* useJournal();
        const journal: ProgramDriverJournal = {
          advance: operations.advance,
          query: operations.query,
          *openTask(request) {
            return yield* journal.advance({ type: "execution.open-task", request });
          },
          *executionState(sessionId, taskId) {
            return yield* journal.query({ type: "task.execution-state", sessionId, taskId });
          },
          *recoveryState(sessionId, requestedTaskId) {
            return yield* journal.query({
              type: "task.recovery-state",
              sessionId,
              taskId: requestedTaskId,
            });
          },
          *rootTaskCount(sessionId) {
            return yield* journal.query({ type: "session.root-task-count", sessionId });
          },
          *operationState(sessionId, taskId, pullId) {
            return yield* journal.query({ type: "pull.state", sessionId, taskId, pullId });
          },
          *readJournal(sessionId, rootTaskId) {
            return [
              ...(rootTaskId
                ? yield* operations.readTree(sessionId, rootTaskId)
                : yield* operations.readSession(sessionId)),
            ];
          },
          *requestCancellation(sessionId, taskId, reason, commandId) {
            yield* journal.advance({
              type: "execution.request-cancellation",
              request: {
                sessionId,
                taskId,
                reason,
                commandId,
              },
            });
          },
          *resolvePending(request) {
            const capability = yield* journal.query({
              type: "pull.resolution-capability",
              sessionId: request.sessionId,
              taskId: request.taskId,
              pullId: request.pullId,
            });
            return yield* journal.advance({
              type: "execution.resolve-pull",
              request: { capability, audience: request.audience, outcome: request.outcome },
            });
          },
          *validateElicitResponse(request) {
            return yield* journal.query({ type: "pull.validate-elicit-response", request });
          },
          *pullPreparation(sessionId, taskId, pullId) {
            return yield* journal.query({ type: "pull.preparation", sessionId, taskId, pullId });
          },
          *acceptPullPreparation(request) {
            return yield* journal.advance({ type: "execution.accept-preparation", request });
          },
          *authorizeModelDispatch(request) {
            return yield* journal.query({ type: "pull.authorize-model-dispatch", request });
          },
          *acceptAssistantPartial(request) {
            return yield* journal.advance({ type: "execution.accept-assistant-partial", request });
          },
        };
        return yield* operation(journal);
      });
    },
  };
}
