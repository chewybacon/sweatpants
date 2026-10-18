import type { ProgramStep } from "@sweatpants/durable-execution";
import type { Json } from "@sweatpants/foundation";
import type { Operation } from "effection";

import type {
  OrphanReason,
  AuthorityCommand,
  AuthorityQuery,
  CommandResult,
  JournalAuthorityContract,
  QueryResult,
} from "../contract/authority-contract.ts";
import { createInMemoryJournal } from "../shell/in-memory-journal.ts";
import type {
  DurableAuthoritySnapshot,
  InMemoryJournalAuthorityOptions,
} from "../state/authority-snapshot.ts";
import type { DurableSemanticRecord } from "../contract/semantic-record.ts";
import type {
  AppendEmissionRequest,
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
  BreachForkGroupRequest,
  BreachForkGroupResult,
  ForceOrphanForkGroupRequest,
  ForceOrphanForkGroupResult,
  OpenForkGroupRequest,
  OpenForkGroupResult,
  CommitPeerDelegationRequest,
  CommitPeerDelegationResult,
  CommitPeerEvidenceRequest,
  CommitPeerEvidenceResult,
  ReportPeerLossRequest,
  ReportPeerLossResult,
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
import { normalizeEmissionPolicy } from "../state/authority-support.ts";
import { signCapability } from "../contract/capabilities.ts";
export type AuthorityScenarioDriver =
  ReturnType<typeof createAuthorityScenarioDriver> extends Operation<infer Driver> ? Driver : never;

export function* createAuthorityScenarioDriver(options: InMemoryJournalAuthorityOptions) {
  normalizeEmissionPolicy(options.emissionPolicy);
  const drivers = yield* createInMemoryJournal(options);
  let latest = options.snapshot ?? emptySnapshot();
  const capabilities = new Map<string, string>();

  function* command<C extends AuthorityCommand>(value: C): Operation<CommandResult<C>> {
    const result = yield* drivers.advance(value);
    latest = yield* drivers.exportSnapshot();
    if (
      value.type === "execution.reserve-pull" &&
      result !== null &&
      typeof result === "object" &&
      "resolutionCapability" in result &&
      typeof result.resolutionCapability === "string"
    ) {
      capabilities.set(result.pullId, result.resolutionCapability);
    }
    return result;
  }

  function direct<C extends AuthorityCommand>(value: C): Operation<CommandResult<C>> {
    return command(value);
  }

  const authority: JournalAuthorityContract & {
    journalIdentity(): { readonly id: string; readonly incarnation: string };
    taskExecutionState(sessionId: string, taskId: string): Operation<DurableTaskExecutionState>;
    taskInput(sessionId: string, taskId: string): Operation<Json>;
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
    consumeRestoreTicket(
      request: ConsumeRestoreTicketRequest,
    ): Operation<ConsumeRestoreTicketResult>;
    cancellationState(sessionId: string, taskId: string): Operation<DurableCancellationState>;
    beginCancellationUnwind(
      sessionId: string,
      taskId: string,
      restoredFrontier?: {
        proof: RestoredFrontierProof;
        step: ProgramStep;
      },
    ): Operation<DurableCancellationState>;
    bindProgramAttachment(
      sessionId: string,
      taskId: string,
      attachmentId: string,
      executionEpoch: number,
    ): Operation<{ programCapability: string }>;
    openTask(request: OpenDurableTaskRequest): Operation<{ programCapability: string }>;
    ensureChildTask(request: EnsureChildTaskRequest): Operation<EnsureChildTaskResult>;
    openForkGroup(request: OpenForkGroupRequest): Operation<OpenForkGroupResult>;
    breachForkGroup(request: BreachForkGroupRequest): Operation<BreachForkGroupResult>;
    forceOrphanForkGroup(
      request: ForceOrphanForkGroupRequest,
    ): Operation<ForceOrphanForkGroupResult>;
    commitPeerDelegation(
      request: CommitPeerDelegationRequest,
    ): Operation<CommitPeerDelegationResult>;
    commitPeerEvidence(request: CommitPeerEvidenceRequest): Operation<CommitPeerEvidenceResult>;
    reportPeerLoss(request: ReportPeerLossRequest): Operation<ReportPeerLossResult>;
    /** Test-side mint mirroring the kernel's program-capability claims, so
     *  scenarios can drive member tasks opened inside group admission. */
    programCapability(sessionId: string, taskId: string): string;
    replaceAttachment(
      sessionId: string,
      taskId: string,
      attachmentId: string,
      audience?: string,
    ): Operation<{ executionEpoch: number; programCapability: string }>;
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
    emit(request: AppendEmissionRequest): Operation<EmissionReceipt>;
    complete(request: CompleteTaskRequest): Operation<CompleteTaskResult>;
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
    resolutionCapability(sessionId: string, taskId: string, pullId: string): string;
    readJournal(sessionId: string): DurableSemanticRecord[];
    readTaskJournal(sessionId: string, rootTaskId: string): DurableSemanticRecord[];
    runnableSessions(): string[];
    exportSnapshot(): DurableAuthoritySnapshot;
  } = {
    command,
    query: drivers.query,
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
        /* CONDITIONAL-SPREAD: Omit absent taskId from journal commands, decisions, and replay records; explicit undefined is not a portable JSON value. */
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
      return yield* direct({ type: "control.claim-activation", request });
    },
    *renewActivation(request) {
      return yield* direct({ type: "control.renew-activation", request });
    },
    *releaseActivation(request) {
      return yield* direct({ type: "control.release-activation", request });
    },
    *issueRestoreTicket(request) {
      return yield* direct({ type: "recovery.issue-ticket", request });
    },
    *prepareProgramRestore(request) {
      return yield* direct({ type: "recovery.prepare-restore", request });
    },
    *bindRestoreFrontier(request) {
      return yield* direct({ type: "recovery.bind-frontier", request });
    },
    *consumeRestoreTicket(request) {
      return yield* direct({ type: "recovery.consume-ticket", request });
    },
    *cancellationState(sessionId, taskId) {
      return yield* query({ type: "task.cancellation-state", sessionId, taskId });
    },
    *beginCancellationUnwind(sessionId, taskId, restoredFrontier) {
      return yield* direct({
        type: "execution.begin-cancellation-unwind",
        request: {
          sessionId,
          taskId,
          /* CONDITIONAL-SPREAD: Omit absent restoredFrontier from journal commands, decisions, and replay records; explicit undefined is not a portable JSON value. */
          ...(restoredFrontier === undefined ? {} : { restoredFrontier }),
        },
      });
    },
    *bindProgramAttachment(sessionId, taskId, attachmentId, _executionEpoch) {
      const current = yield* query({ type: "task.execution-state", sessionId, taskId });
      return yield* direct({
        type: "execution.bind-attachment",
        request: { sessionId, taskId, attachmentId, executionEpoch: current.executionEpoch },
      });
    },
    *openTask(request) {
      return yield* direct({ type: "execution.open-task", request });
    },
    *ensureChildTask(request) {
      return yield* direct({ type: "execution.ensure-child", request });
    },
    *openForkGroup(request) {
      return yield* direct({ type: "execution.open-fork-group", request });
    },
    *breachForkGroup(request) {
      return yield* direct({ type: "execution.breach-fork-group", request });
    },
    *forceOrphanForkGroup(request) {
      return yield* direct({ type: "execution.force-orphan-fork-group", request });
    },
    *commitPeerDelegation(request) {
      return yield* direct({ type: "execution.commit-peer-delegation", request });
    },
    *commitPeerEvidence(request) {
      return yield* direct({ type: "execution.commit-peer-evidence", request });
    },
    *reportPeerLoss(request) {
      return yield* direct({ type: "execution.report-peer-loss", request });
    },
    programCapability(sessionId, taskId) {
      const task = latest.sessions
        .find(([id]) => id === sessionId)?.[1]
        .execution.tasks.find((candidate) => candidate.taskId === taskId);
      if (!task) {
        throw new Error(`Unknown task ${taskId}`);
      }
      return signCapability(
        {
          journalId: options.journalId,
          journalIncarnation: options.journalIncarnation ?? "1",
          sessionId,
          taskId,
          programId: task.program.artifact.id,
          programVersion: task.program.artifact.version,
          programDigest: task.program.artifact.digest,
          attachmentId: task.execution.attachmentId,
          executionEpoch: task.execution.epoch,
          audience: task.execution.audience,
          permissions: ["propose", "complete"],
          nonce: `scenario-driver:${taskId}:${capabilities.size}`,
        },
        options.keyring,
      );
    },
    *replaceAttachment(sessionId, taskId, attachmentId, audience) {
      return yield* direct({
        type: "execution.replace-attachment",
        request: {
          sessionId,
          taskId,
          attachmentId,
          /* CONDITIONAL-SPREAD: Omit absent audience from journal commands, decisions, and replay records; explicit undefined is not a portable JSON value. */
          ...(audience === undefined ? {} : { audience }),
        },
      });
    },
    *reserve(request) {
      return yield* direct({ type: "execution.reserve-pull", request });
    },
    *acceptPullPreparation(request) {
      return yield* direct({ type: "execution.accept-preparation", request });
    },
    *authorizeModelDispatch(request) {
      return yield* query({ type: "pull.authorize-model-dispatch", request });
    },
    *acceptAssistantPartial(request) {
      return yield* direct({ type: "execution.accept-assistant-partial", request });
    },
    *resolve(request) {
      return yield* direct({ type: "execution.resolve-pull", request });
    },
    *emit(request) {
      return yield* direct({ type: "execution.append-emission", request });
    },
    *complete(request) {
      return yield* direct({ type: "execution.complete-task", request });
    },
    *requestCancellation(sessionId, taskId, reason, commandId) {
      return yield* direct({
        type: "execution.request-cancellation",
        request: {
          sessionId,
          taskId,
          /* CONDITIONAL-SPREAD: Omit absent reason from journal commands, decisions, and replay records; explicit undefined is not a portable JSON value. */
          ...(reason === undefined ? {} : { reason }),
          /* CONDITIONAL-SPREAD: Omit absent commandId from journal commands, decisions, and replay records; explicit undefined is not a portable JSON value. */
          ...(commandId === undefined ? {} : { commandId }),
        },
      });
    },
    *detachAttempt(sessionId, taskId, pullId, reason) {
      yield* direct({
        type: "execution.detach-attempt",
        request: {
          sessionId,
          taskId,
          pullId /* CONDITIONAL-SPREAD: Omit absent reason from journal commands, decisions, and replay records; explicit undefined is not a portable JSON value. */,
          ...(reason === undefined ? {} : { reason }),
        },
      });
    },
    *abandonAttempt(sessionId, taskId, pullId, attemptId, reason) {
      yield* direct({
        type: "execution.abandon-attempt",
        request: {
          sessionId,
          taskId,
          pullId,
          attemptId,
          /* CONDITIONAL-SPREAD: Omit absent reason from journal commands, decisions, and replay records; explicit undefined is not a portable JSON value. */
          ...(reason === undefined ? {} : { reason }),
        },
      });
    },
    *forceOrphan(sessionId, taskId, reason) {
      yield* direct({ type: "execution.force-orphan", request: { sessionId, taskId, reason } });
    },
    resolutionCapability(sessionId, taskId, pullId) {
      const cached = capabilities.get(pullId);
      if (cached) {
        return cached;
      }
      const task = latest.sessions
        .find(([id]) => id === sessionId)?.[1]
        .execution.tasks.find((candidate) => candidate.taskId === taskId);
      const pull = task?.actions.find(
        (action) => action.kind === "pull" && action.pull.pullId === pullId,
      );
      if (pull?.kind === "pull") {
        const attempt = [...pull.pull.attempts]
          .reverse()
          .find((candidate) => candidate.status === "started");
        if (attempt) {
          return attempt.capability;
        }
        if (pull.pull.resolutionAuthority.kind !== "attempt") {
          return pull.pull.resolutionAuthority.capability;
        }
      }
      throw new Error(`Unknown pull ${pullId}`);
    },
    readJournal(sessionId) {
      return structuredClone(latest.records.find(([id]) => id === sessionId)?.[1] ?? []);
    },
    readTaskJournal(sessionId, rootTaskId) {
      const records = this.readJournal(sessionId);
      const taskIds = new Set([rootTaskId]);
      let changed = true;
      while (changed) {
        changed = false;
        for (const record of records) {
          if (
            record.payload.type === "TaskOpened" &&
            record.payload.parentTaskId &&
            taskIds.has(record.payload.parentTaskId) &&
            !taskIds.has(record.payload.taskId)
          ) {
            taskIds.add(record.payload.taskId);
            changed = true;
          }
        }
      }
      return records.filter(
        (record) => "taskId" in record.payload && taskIds.has(record.payload.taskId),
      );
    },
    runnableSessions() {
      return latest.sessions.filter(([, session]) => session.control.runnable).map(([id]) => id);
    },
    exportSnapshot() {
      return structuredClone(latest);
    },
  };

  function query<Q extends AuthorityQuery>(value: Q): Operation<QueryResult<Q>> {
    return drivers.query(value);
  }

  return authority;
}

function emptySnapshot(): DurableAuthoritySnapshot {
  return { version: 1, sessions: [], nextNonce: 0, records: [] };
}
