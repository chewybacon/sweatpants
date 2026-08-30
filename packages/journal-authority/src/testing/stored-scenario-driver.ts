import type { Operation } from "effection";

import {
  createStoredShellDrivers,
  type StoredJournalAuthorityOptions,
  type StoredShellDrivers,
} from "../shell/stored-shell.ts";
import type { DurableAuthoritySnapshot } from "../state/authority-snapshot.ts";
import type { DurableSemanticRecord } from "../contract/semantic-record.ts";
import type {
  AcceptAssistantPartialRequest,
  AcceptAssistantPartialResult,
  AcceptPullPreparationRequest,
  AcceptPullPreparationResult,
  AuthorizeModelDispatchRequest,
  AuthorizeModelDispatchResult,
  BindRestoreFrontierRequest,
  BindRestoreFrontierResult,
  CancellationAcknowledgement,
  ClaimActivationRequest,
  ClaimActivationResult,
  CompleteTaskRequest,
  CompleteTaskResult,
  ConsumeRestoreTicketRequest,
  ConsumeRestoreTicketResult,
  DurableCancellationState,
  DurableOperationState,
  DurableTaskExecutionState,
  DurableTaskRecoveryState,
  EmissionReceipt,
  EnsureChildTaskRequest,
  EnsureChildTaskResult,
  IssueRestoreTicketRequest,
  IssueRestoreTicketResult,
  ModelContextPreparedFact,
  OpenDurableTaskRequest,
  PrepareProgramRestoreRequest,
  PreparedProgramRestore,
  RecoverableSession,
  ReleaseActivationRequest,
  ReleaseActivationResult,
  RenewActivationRequest,
  RenewActivationResult,
  ReserveOperationRequest,
  ReserveOperationResult,
  ResolveOperationRequest,
  ResolveOperationResult,
  RestoredFrontierProof,
  ValidateElicitResponseRequest,
  ValidateElicitResponseResult,
} from "../contract/authority-types.ts";
import type { OrphanReason } from "../contract/authority-contract.ts";

export type StoredScenarioDriver = StoredShellDrivers & {
  journalIdentity(): { readonly id: string; readonly incarnation: string };
  taskExecutionState(sessionId: string, taskId: string): Operation<DurableTaskExecutionState>;
  taskInput(sessionId: string, taskId: string): Operation<import("@sweatpants/foundation").Json>;
  taskRecoveryState(sessionId: string, taskId?: string): Operation<DurableTaskRecoveryState>;
  rootTaskCount(sessionId: string): Operation<number>;
  operationState(
    sessionId: string,
    taskId: string,
    pullId: string,
  ): Operation<DurableOperationState>;
  pullPreparation(
    sessionId: string,
    taskId: string,
    pullId: string,
  ): Operation<ModelContextPreparedFact | null>;
  validateElicitResponse(
    request: ValidateElicitResponseRequest,
  ): Operation<ValidateElicitResponseResult>;
  nonterminalSchemaDigests(): Operation<string[]>;
  recoverableSessions(): Operation<RecoverableSession[]>;
  claimActivation(request: ClaimActivationRequest): Operation<ClaimActivationResult>;
  renewActivation(request: RenewActivationRequest): Operation<RenewActivationResult>;
  releaseActivation(request: ReleaseActivationRequest): Operation<ReleaseActivationResult>;
  issueRestoreTicket(request: IssueRestoreTicketRequest): Operation<IssueRestoreTicketResult>;
  prepareProgramRestore(request: PrepareProgramRestoreRequest): Operation<PreparedProgramRestore>;
  bindRestoreFrontier(request: BindRestoreFrontierRequest): Operation<BindRestoreFrontierResult>;
  consumeRestoreTicket(request: ConsumeRestoreTicketRequest): Operation<ConsumeRestoreTicketResult>;
  cancellationState(sessionId: string, taskId: string): Operation<DurableCancellationState>;
  beginCancellationUnwind(
    sessionId: string,
    taskId: string,
    restoredFrontier?: {
      proof: RestoredFrontierProof;
      step: import("@sweatpants/durable-execution").ProgramStep;
    },
  ): Operation<DurableCancellationState>;
  bindProgramAttachment(
    sessionId: string,
    taskId: string,
    attachmentId: string,
    executionEpoch: number,
  ): Operation<{ programCapability: string }>;
  ensureChildTask(request: EnsureChildTaskRequest): Operation<EnsureChildTaskResult>;
  reserve(request: ReserveOperationRequest): Operation<ReserveOperationResult>;
  acceptPullPreparation(
    request: AcceptPullPreparationRequest,
  ): Operation<AcceptPullPreparationResult>;
  authorizeModelDispatch(
    request: AuthorizeModelDispatchRequest,
  ): Operation<AuthorizeModelDispatchResult>;
  acceptAssistantPartial(
    request: AcceptAssistantPartialRequest,
  ): Operation<AcceptAssistantPartialResult>;
  resolve(request: ResolveOperationRequest): Operation<ResolveOperationResult>;
  emit(
    request: import("../contract/authority-types.ts").AppendEmissionRequest,
  ): Operation<EmissionReceipt>;
  complete(request: CompleteTaskRequest): Operation<CompleteTaskResult>;
  openTask(request: OpenDurableTaskRequest): Operation<{ programCapability: string }>;
  replaceAttachment(
    sessionId: string,
    taskId: string,
    attachmentId: string,
    audience?: string,
  ): Operation<{ executionEpoch: number; programCapability: string }>;
  requestCancellation(
    sessionId: string,
    taskId: string,
    reason?: string,
    commandId?: string,
  ): Operation<CancellationAcknowledgement>;
  detachAttempt(
    sessionId: string,
    taskId: string,
    pullId: string,
    reason?: string,
  ): Operation<void>;
  abandonAttempt(
    sessionId: string,
    taskId: string,
    pullId: string,
    attemptId: string,
    reason?: string,
  ): Operation<void>;
  forceOrphan(sessionId: string, taskId: string, reason: OrphanReason): Operation<void>;
  resolutionCapability(sessionId: string, taskId: string, pullId: string): Operation<string>;
  readJournal(sessionId: string): Operation<DurableSemanticRecord[]>;
  readTaskJournal(sessionId: string, rootTaskId: string): Operation<DurableSemanticRecord[]>;
  runnableSessions(): Operation<string[]>;
  exportSnapshot(): Operation<DurableAuthoritySnapshot>;
};

export function createStoredScenarioDriver(
  store: import("../store/store.ts").ExecutionStore,
  options: StoredJournalAuthorityOptions,
): StoredScenarioDriver {
  const drivers = createStoredShellDrivers(store, options);
  const authority = drivers.authority;
  const query = authority.query.bind(authority);
  const command = authority.command.bind(authority);
  return {
    ...drivers,
    journalIdentity() {
      return { id: options.journalId, incarnation: options.journalIncarnation ?? "1" };
    },
    *taskExecutionState(sessionId, taskId) {
      return yield* query({ type: "task.execution-state", sessionId, taskId });
    },
    *taskInput(sessionId, taskId) {
      return yield* query({ type: "task.input", sessionId, taskId });
    },
    *taskRecoveryState(sessionId, taskId) {
      return yield* query({
        type: "task.recovery-state",
        sessionId,
        ...(taskId === undefined ? {} : { taskId }),
      });
    },
    *rootTaskCount(sessionId) {
      return yield* query({ type: "session.root-task-count", sessionId });
    },
    *operationState(sessionId, taskId, pullId) {
      return yield* query({ type: "pull.state", sessionId, taskId, pullId });
    },
    *pullPreparation(sessionId, taskId, pullId) {
      return yield* query({ type: "pull.preparation", sessionId, taskId, pullId });
    },
    *validateElicitResponse(request) {
      return yield* query({ type: "pull.validate-elicit-response", request });
    },
    *nonterminalSchemaDigests() {
      return [...(yield* query({ type: "authority.nonterminal-schema-digests" }))];
    },
    *recoverableSessions() {
      return [...(yield* query({ type: "authority.recoverable-sessions" }))];
    },
    *claimActivation(request) {
      return yield* command({ type: "control.claim-activation", request });
    },
    *renewActivation(request) {
      return yield* command({ type: "control.renew-activation", request });
    },
    *releaseActivation(request) {
      return yield* command({ type: "control.release-activation", request });
    },
    *issueRestoreTicket(request) {
      return yield* command({ type: "recovery.issue-ticket", request });
    },
    *prepareProgramRestore(request) {
      return yield* command({ type: "recovery.prepare-restore", request });
    },
    *bindRestoreFrontier(request) {
      return yield* command({ type: "recovery.bind-frontier", request });
    },
    *consumeRestoreTicket(request) {
      return yield* command({ type: "recovery.consume-ticket", request });
    },
    *cancellationState(sessionId, taskId) {
      return yield* query({ type: "task.cancellation-state", sessionId, taskId });
    },
    *beginCancellationUnwind(sessionId, taskId, restoredFrontier) {
      return yield* command({
        type: "execution.begin-cancellation-unwind",
        request: {
          sessionId,
          taskId,
          ...(restoredFrontier === undefined ? {} : { restoredFrontier }),
        },
      });
    },
    *bindProgramAttachment(sessionId, taskId, attachmentId, _executionEpoch) {
      const current = yield* query({ type: "task.execution-state", sessionId, taskId });
      return yield* command({
        type: "execution.bind-attachment",
        request: { sessionId, taskId, attachmentId, executionEpoch: current.executionEpoch },
      });
    },
    *ensureChildTask(request) {
      return yield* command({ type: "execution.ensure-child", request });
    },
    *reserve(request) {
      return yield* command({ type: "execution.reserve-pull", request });
    },
    *acceptPullPreparation(request) {
      return yield* command({ type: "execution.accept-preparation", request });
    },
    *authorizeModelDispatch(request) {
      return yield* query({ type: "pull.authorize-model-dispatch", request });
    },
    *acceptAssistantPartial(request) {
      return yield* command({ type: "execution.accept-assistant-partial", request });
    },
    *resolve(request) {
      return yield* command({ type: "execution.resolve-pull", request });
    },
    *emit(request) {
      return yield* command({ type: "execution.append-emission", request });
    },
    *complete(request) {
      return yield* command({ type: "execution.complete-task", request });
    },
    *openTask(request) {
      return yield* command({ type: "execution.open-task", request });
    },
    *replaceAttachment(sessionId, taskId, attachmentId, audience) {
      return yield* command({
        type: "execution.replace-attachment",
        request: {
          sessionId,
          taskId,
          attachmentId,
          ...(audience === undefined ? {} : { audience }),
        },
      });
    },
    *requestCancellation(sessionId, taskId, reason, commandId) {
      return yield* command({
        type: "execution.request-cancellation",
        request: {
          sessionId,
          taskId,
          ...(reason === undefined ? {} : { reason }),
          ...(commandId === undefined ? {} : { commandId }),
        },
      });
    },
    *detachAttempt(sessionId, taskId, pullId, reason) {
      yield* command({
        type: "execution.detach-attempt",
        request: { sessionId, taskId, pullId, ...(reason === undefined ? {} : { reason }) },
      });
    },
    *abandonAttempt(sessionId, taskId, pullId, attemptId, reason) {
      yield* command({
        type: "execution.abandon-attempt",
        request: { sessionId, taskId, pullId, attemptId, reason: reason ?? "revoked" },
      });
    },
    *forceOrphan(sessionId, taskId, reason) {
      yield* command({ type: "execution.force-orphan", request: { sessionId, taskId, reason } });
    },
    *resolutionCapability(sessionId, taskId, pullId) {
      return yield* query({ type: "pull.resolution-capability", sessionId, taskId, pullId });
    },
    *readJournal(sessionId) {
      return [...(yield* drivers.journal.readSession(sessionId))];
    },
    *readTaskJournal(sessionId, rootTaskId) {
      return [...(yield* drivers.journal.readTree(sessionId, rootTaskId))];
    },
    *runnableSessions() {
      return [...(yield* query({ type: "authority.runnable-sessions" }))];
    },
    *exportSnapshot() {
      return yield* drivers.snapshot.exportSnapshot();
    },
  };
}
