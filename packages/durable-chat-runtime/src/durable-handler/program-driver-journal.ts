import { type OperationOutcome } from "@sweatpants/durable-effects";
import { scoped, type Operation } from "effection";
import {
  AuthorityJournalPort,
  JournalAuthorityPort,
  createCapabilityKeyring,
  installStoredJournalAuthority,
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
import { installExecutionStore } from "@sweatpants/journal-authority/api";
import { createMemoryExecutionStore } from "@sweatpants/journal-authority/memory";
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
  withAuthority<T>(operation: (authority: JournalAuthorityContract) => Operation<T>): Operation<T>;
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
  open(conversationId: string): Operation<ProgramDriverJournal>;
}

export interface ProgramDriverJournalStoreOptions {
  keyring: CapabilityKeyring;
  journalPrefix?: string;
  now?: () => number;
  schemaRegistry?: DurableSchemaRegistry;
  executionStore?: ExecutionStore;
  privateSegmentTarget?: PrivateSegmentTarget;
}

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
      const authorityOptions = {
        journalId: `${options.journalPrefix ?? "program-driver"}:${conversationId}`,
        journalIncarnation: "1",
        keyring: options.keyring,
        ...(options.now ? { now: options.now } : {}),
        ...(options.privateSegmentTarget
          ? { privateSegmentTarget: options.privateSegmentTarget }
          : {}),
        schemaRegistry: options.schemaRegistry ?? programDriverSchemaRegistry(),
      };

      const install = function* (): Operation<void> {
        yield* installExecutionStore(executionStore);
        yield* installStoredJournalAuthority(authorityOptions);
      };
      const withAuthority = function* <T>(
        operation: (authority: JournalAuthorityContract) => Operation<T>,
      ): Operation<T> {
        return yield* scoped(function* () {
          yield* install();
          const authority = yield* JournalAuthorityPort.use();
          return yield* operation(authority);
        });
      };

      return {
        install,
        withAuthority,
        *openTask(request) {
          return yield* withAuthority((authority) =>
            authority.command({ type: "execution.open-task", request }),
          );
        },
        *executionState(sessionId, taskId) {
          return yield* withAuthority((authority) =>
            authority.query({ type: "task.execution-state", sessionId, taskId }),
          );
        },
        *recoveryState(sessionId, requestedTaskId) {
          return yield* withAuthority((authority) =>
            authority.query({
              type: "task.recovery-state",
              sessionId,
              ...(requestedTaskId !== undefined ? { taskId: requestedTaskId } : {}),
            }),
          );
        },
        *rootTaskCount(sessionId) {
          return yield* withAuthority((authority) =>
            authority.query({ type: "session.root-task-count", sessionId }),
          );
        },
        *operationState(sessionId, taskId, pullId) {
          return yield* withAuthority((authority) =>
            authority.query({ type: "pull.state", sessionId, taskId, pullId }),
          );
        },
        *readJournal(sessionId, rootTaskId) {
          return yield* scoped(function* () {
            yield* install();
            const journal = yield* AuthorityJournalPort.use();
            return structuredClone([
              ...(rootTaskId
                ? yield* journal.readTree(sessionId, rootTaskId)
                : yield* journal.readSession(sessionId)),
            ]);
          });
        },
        *requestCancellation(sessionId, taskId, reason, commandId) {
          yield* withAuthority((authority) =>
            authority.command({
              type: "execution.request-cancellation",
              request: {
                sessionId,
                taskId,
                ...(reason !== undefined ? { reason } : {}),
                ...(commandId !== undefined ? { commandId } : {}),
              },
            }),
          );
        },
        *resolvePending(request) {
          return yield* withAuthority(function* (authority) {
            const capability = yield* authority.query({
              type: "pull.resolution-capability",
              sessionId: request.sessionId,
              taskId: request.taskId,
              pullId: request.pullId,
            });
            return yield* authority.command({
              type: "execution.resolve-pull",
              request: { capability, audience: request.audience, outcome: request.outcome },
            });
          });
        },
        *validateElicitResponse(request) {
          return yield* withAuthority((authority) =>
            authority.query({ type: "pull.validate-elicit-response", request }),
          );
        },
        *pullPreparation(sessionId, taskId, pullId) {
          return yield* withAuthority((authority) =>
            authority.query({ type: "pull.preparation", sessionId, taskId, pullId }),
          );
        },
        *acceptPullPreparation(request) {
          return yield* withAuthority((authority) =>
            authority.command({ type: "execution.accept-preparation", request }),
          );
        },
        *authorizeModelDispatch(request) {
          return yield* withAuthority((authority) =>
            authority.query({ type: "pull.authorize-model-dispatch", request }),
          );
        },
        *acceptAssistantPartial(request) {
          return yield* withAuthority((authority) =>
            authority.command({ type: "execution.accept-assistant-partial", request }),
          );
        },
      };
    },
  };
}
