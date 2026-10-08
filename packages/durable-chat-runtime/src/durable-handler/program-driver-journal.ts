import { type OperationOutcome } from "@sweatpants/durable-effects";
import { scoped, type Operation } from "effection";
import {
  AuthorityJournalPort,
  JournalAuthorityPort,
  createCapabilityKeyring,
  createJournal,
  installJournal,
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
  type JournalAuthorityContract,
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
  install(): Operation<void>;
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
  /** Owns one authority view until the calling scope exits; children share it. */
  open(conversationId: string): Operation<ProgramDriverJournal>;
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
    *open(conversationId): Operation<ProgramDriverJournal> {
      const authorityOptions = {
        journalId: `${options.journalPrefix ?? "program-driver"}:${conversationId}`,
        journalIncarnation: "1",
        keyring: options.keyring,
        now: options.now,
        privateSegmentTarget: options.privateSegmentTarget,
        dataDirectory: options.dataDirectory || undefined,
        schemaRegistry: options.schemaRegistry ?? programDriverSchemaRegistry(),
      };

      const owned = yield* createJournal(ExecutionStorePort.api.operations, authorityOptions);
      const install = function* (): Operation<void> {
        yield* installExecutionStore(executionStore);
        yield* installJournal(owned);
      };
      // Selecting a journal installs its storage and port drivers in a child scope.
      // This preserves caller middleware and permits independent journals in one caller.
      const dispatch = function* <T>(
        operation: (authority: JournalAuthorityContract) => Operation<T>,
      ): Operation<T> {
        return yield* scoped(function* () {
          yield* install();
          const authority = yield* JournalAuthorityPort.use();
          return yield* operation(authority);
        });
      };

      const journal: ProgramDriverJournal = {
        install,
        *advance(command) {
          return yield* dispatch((authority) => authority.command(command));
        },
        *query(query) {
          return yield* dispatch((authority) => authority.query(query));
        },
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
            ...(requestedTaskId !== undefined ? { taskId: requestedTaskId } : {}),
          });
        },
        *rootTaskCount(sessionId) {
          return yield* journal.query({ type: "session.root-task-count", sessionId });
        },
        *operationState(sessionId, taskId, pullId) {
          return yield* journal.query({ type: "pull.state", sessionId, taskId, pullId });
        },
        *readJournal(sessionId, rootTaskId) {
          return yield* scoped(function* () {
            yield* install();
            const records = yield* AuthorityJournalPort.use();
            // Journal reads already return detached records at their boundary.
            return [
              ...(rootTaskId
                ? yield* records.readTree(sessionId, rootTaskId)
                : yield* records.readSession(sessionId)),
            ];
          });
        },
        *requestCancellation(sessionId, taskId, reason, commandId) {
          yield* journal.advance({
            type: "execution.request-cancellation",
            request: {
              sessionId,
              taskId,
              ...(reason !== undefined ? { reason } : {}),
              ...(commandId !== undefined ? { commandId } : {}),
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
      return journal;
    },
  };
}
