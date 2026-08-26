import { pullKindPolicy } from "./pull-kinds/index.ts";
import {
  assertForkPolicyPairing,
  beginForkGroupCancellation,
  drainForkGroup,
  forceOrphanForkGroupResolution,
  forkGroupIdFor,
  forkGroupOutcome,
  peerDeliveryCorrelator,
  peerLossOutcome,
  reduceForkMemberTerminal,
  resolveForkDeadline,
  type ForkGroupState,
  type ForkPolicy,
} from "./fork-group.ts";
import {
  CrankError,
  DEFAULT_MAX_INLINE_BYTES,
  assertInlineSize,
  type DurableAllDescriptor,
  type DurableChildDescriptor,
  type DurableOperationDescriptor,
  type DurableRaceDescriptor,
  type DurableProgramManifest,
  type ProgramStep,
  type ReplayEmissionEntry,
  type ReplayEntry,
  type ReplayOperationEntry,
  type ResolutionReceipt,
} from "@sweatpants/durable-execution";
import type { OperationOutcome } from "@sweatpants/durable-effects";
import {
  canonicalJson,
  canonicalSnapshot,
  sha256,
  stableTupleHash,
  type Json,
} from "@sweatpants/foundation";

import type {
  ActionState,
  AuthorityCommand,
  AuthorityDecisionFrame,
  AuthorityQuery,
  AuthoritySessionState,
  AuthorityState,
  CommandResult,
  KernelTransition,
  PullState,
  QueryResult,
  ResolutionAuthority,
  TaskState,
} from "./authority-contract.ts";
import type {
  AcceptAssistantPartialRequest,
  AcceptAssistantPartialResult,
  AcceptPullPreparationRequest,
  AcceptPullPreparationResult,
  ActivationLeaseState,
  AppendEmissionRequest,
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
  IssueRestoreTicketRequest,
  IssueRestoreTicketResult,
  OpenDurableTaskRequest,
  OpenForkGroupRequest,
  OpenForkGroupResult,
  CommitPeerDelegationRequest,
  CommitPeerDelegationResult,
  CommitPeerEvidenceRequest,
  CommitPeerEvidenceResult,
  ReportPeerLossRequest,
  ReportPeerLossResult,
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
  TaskCloseReceipt,
  ValidateElicitResponseRequest,
  ValidateElicitResponseResult,
} from "./authority-types.ts";
import {
  signCapability,
  signPrivateAuthorityToken,
  verifyDeliveryMandate,
  verifyPrivateAuthorityToken,
  verifyProgramCapability,
  verifyResolutionCapability,
} from "./capabilities.ts";
import { parseRegisteredSchema } from "./schema-registry.ts";
import type { DurableSemanticRecord } from "./semantic-record.ts";
import {
  canonicalByteLength,
  effectContractDigest,
  effectDigestForPull,
  identityConflict,
  installedOrRecordedDescriptor,
  isModelSampleDescriptor,
  manifestSchemaDigests,
  MAX_OPEN_ELICITATIONS,
  modelPullOwnerFence,
  normalizeEmissionPolicy,
  operationPolicy,
  parseProgramElicitResult,
  parseRestoreTicketClaims,
  pendingReason,
  sanitizeCancellationReason,
  snapshotDescriptor,
  snapshotOutcome,
  sortedStrings,
  terminalOutcomeDigest,
} from "./authority-support.ts";
import type { SemanticEmissionPolicy } from "./authority-snapshot.ts";

type DeepMutable<T> = T extends readonly (infer U)[]
  ? DeepMutable<U>[]
  : T extends ReadonlyMap<infer K, infer V>
    ? Map<K, DeepMutable<V>>
    : T extends object
      ? { -readonly [P in keyof T]: DeepMutable<T[P]> }
      : T;
type DraftTask = DeepMutable<TaskState>;
type DraftSession = DeepMutable<AuthoritySessionState>;
type DraftState = DeepMutable<AuthorityState>;
type DraftPull = DeepMutable<PullState>;

export interface AuthorityDecisionOptions {
  readonly maxOutcomeBytes?: number;
  readonly emissionPolicy?: SemanticEmissionPolicy;
}

export function decideAuthorityCommand<C extends AuthorityCommand>(
  frame: AuthorityDecisionFrame<C>,
  options: AuthorityDecisionOptions = {},
): KernelTransition<C> {
  const draft = new DecisionDraft(frame, options);
  const result = dispatchCommand(draft, frame.command);
  return {
    state: draft.state,
    entries: draft.entries,
    result: result as CommandResult<C>,
  };
}

export function queryAuthorityState<Q extends AuthorityQuery>(
  state: AuthorityState,
  context: AuthorityDecisionFrame<AuthorityCommand>["context"],
  query: Q,
): QueryResult<Q> {
  let result: unknown;
  switch (query.type) {
    case "authority.identity":
      result = context.journalIdentity;
      break;
    case "authority.nonterminal-schema-digests":
      result = nonterminalSchemaDigests(state);
      break;
    case "authority.recoverable-sessions":
      result = recoverableSessions(state, context.nowMs);
      break;
    case "authority.runnable-sessions":
      result = sortedStrings(
        [...state.sessions].filter(([, session]) => session.control.runnable).map(([id]) => id),
      );
      break;
    case "session.root-task-count":
      result = rootTaskCount(state, query.sessionId);
      break;
    case "task.execution-state":
      result = taskExecutionState(state, query.sessionId, query.taskId);
      break;
    case "task.input":
      result = structuredClone(taskFor(state, query.sessionId, query.taskId).program.input);
      break;
    case "task.recovery-state":
      result = taskRecoveryState(state, query.sessionId, query.taskId);
      break;
    case "task.cancellation-state": {
      const task = taskFor(state, query.sessionId, query.taskId);
      result =
        task.lifecycle.status === "active"
          ? structuredClone(task.lifecycle.cancellation)
          : terminalCancellation(task);
      break;
    }
    case "task.lifecycle": {
      result = { status: taskFor(state, query.sessionId, query.taskId).lifecycle.status };
      break;
    }
    case "pull.state":
      result = operationState(state, query.sessionId, query.taskId, query.pullId);
      break;
    case "pull.preparation":
      result = structuredClone(
        findTaskPullById(state, query.taskId, query.pullId)?.[2].acceptedFacts.preparation ?? null,
      );
      break;
    case "pull.validate-elicit-response":
      result = validateElicitResponse(state, context, query.request);
      break;
    case "pull.authorize-model-dispatch":
      result = authorizeModelDispatch(state, query.request);
      break;
    case "pull.resolution-capability":
      result = resolutionCapabilityFor(
        context,
        cloneState(state),
        query.sessionId,
        query.taskId,
        query.pullId,
      );
      break;
    default:
      return assertNever(query);
  }
  return result as QueryResult<Q>;
}

class DecisionDraft {
  readonly state: DraftState;
  readonly entries: DurableSemanticRecord[] = [];
  readonly context: AuthorityDecisionFrame<AuthorityCommand>["context"];
  readonly maxOutcomeBytes: number;
  readonly emissionPolicy: SemanticEmissionPolicy | undefined;
  readonly offsets = new Map<string, number>();

  constructor(frame: AuthorityDecisionFrame<AuthorityCommand>, options: AuthorityDecisionOptions) {
    this.state = cloneState(frame.state);
    this.context = frame.context;
    this.maxOutcomeBytes = options.maxOutcomeBytes ?? DEFAULT_MAX_INLINE_BYTES;
    this.emissionPolicy = options.emissionPolicy
      ? normalizeEmissionPolicy(options.emissionPolicy)
      : undefined;
    this.offsets.set(frame.context.appendCursor.sessionId, frame.context.appendCursor.nextOffset);
  }

  session(sessionId: string): DraftSession {
    let session = this.state.sessions.get(sessionId);
    if (!session) {
      session = {
        execution: { tasks: new Map() },
        control: {
          runnable: false,
          revision: 0,
          lastActivationEpoch: 0,
          consecutiveRestoreStales: 0,
        },
      };
      this.state.sessions.set(sessionId, session);
    }
    return session;
  }

  task(sessionId: string, taskId: string): DraftTask {
    const task = this.state.sessions.get(sessionId)?.execution.tasks.get(taskId);
    if (!task) throw new CrankError("unknown_target", `Unknown task ${taskId}`);
    return task;
  }

  append(
    sessionId: string,
    ownerEpoch: number | undefined,
    payload: DurableSemanticRecord["payload"],
  ): string {
    const next = this.offsets.get(sessionId) ?? 0;
    const offset = String(next);
    this.offsets.set(sessionId, next + 1);
    this.entries.push({
      offset,
      eventId: `journal:${sessionId}:${offset}`,
      sessionId,
      ...(ownerEpoch === undefined ? {} : { ownerEpoch }),
      payload: structuredClone(payload),
    });
    const session = this.session(sessionId);
    session.control.revision += 1;
    return offset;
  }

  nonce(): string {
    this.state.nextNonce += 1;
    return stableTupleHash(["nonce", this.context.journalIdentity.id, this.state.nextNonce]);
  }

  programCapability(task: DraftTask): string {
    return signCapability(
      {
        journalId: this.context.journalIdentity.id,
        journalIncarnation: this.context.journalIdentity.incarnation,
        sessionId: taskOriginSession(this.state, task.taskId),
        taskId: task.taskId,
        programId: task.program.artifact.id,
        programVersion: task.program.artifact.version,
        programDigest: task.program.artifact.digest,
        attachmentId: task.execution.attachmentId,
        executionEpoch: task.execution.epoch,
        audience: task.execution.audience,
        permissions: ["propose", "complete"],
        nonce: this.nonce(),
      },
      this.context.keyring,
    );
  }

  resolutionCapability(task: DraftTask, pull: DraftPull, attemptId: string | undefined): string {
    return signCapability(
      {
        journalId: this.context.journalIdentity.id,
        journalIncarnation: this.context.journalIdentity.incarnation,
        sessionId: taskOriginSession(this.state, task.taskId),
        taskId: task.taskId,
        pullId: pull.pullId,
        descriptorDigest: pull.request.proposedDescriptorDigest,
        resultSchemaDigest: pull.request.resultSchemaDigest,
        attemptId: attemptId ?? "none",
        audience: pullAudience(pull),
        permissions: ["resolve"],
        maxOutcomeBytes: pull.request.maxOutcomeBytes,
        nonce: this.nonce(),
      },
      this.context.keyring,
    );
  }

  assertActive(task: DraftTask): void {
    if (task.lifecycle.status !== "active") throw new CrankError("task_terminal");
  }

  assertProgram(token: string, task: DraftTask, sessionId: string): void {
    const claims = verifyProgramCapability(token, this.context.keyring, {
      audience: task.execution.audience,
      journalId: this.context.journalIdentity.id,
      journalIncarnation: this.context.journalIdentity.incarnation,
      sessionId,
      taskId: task.taskId,
      executionEpoch: task.execution.epoch,
      attachmentId: task.execution.attachmentId,
    });
    if (
      claims.programId !== task.program.artifact.id ||
      claims.programVersion !== task.program.artifact.version ||
      claims.programDigest !== task.program.artifact.digest
    ) {
      throw new CrankError("program_version_mismatch");
    }
  }

  parseSchema(digest: string, value: unknown, errorCode: string): Json {
    const validated = parseRegisteredSchema(this.context.schemas, digest, value);
    if (validated.status === "unavailable") {
      throw new CrankError("schema_version_unavailable");
    }
    if (validated.status === "invalid" || validated.status === "schema-error") {
      throw new CrankError(errorCode);
    }
    return validated.value;
  }
}

function dispatchCommand<C extends AuthorityCommand>(
  draft: DecisionDraft,
  command: C,
): CommandResult<C> {
  let result: unknown;
  switch (command.type) {
    case "execution.open-task":
      result = openTask(draft, command.request);
      break;
    case "execution.bind-attachment":
      result = bindAttachment(draft, command.request);
      break;
    case "execution.replace-attachment":
      result = replaceAttachment(draft, command.request);
      break;
    case "execution.ensure-child":
      result = ensureChild(draft, command.request);
      break;
    case "execution.open-fork-group":
      result = openForkGroup(draft, command.request);
      break;
    case "execution.breach-fork-group":
      result = breachForkGroup(draft, command.request);
      break;
    case "execution.force-orphan-fork-group":
      result = forceOrphanForkGroup(draft, command.request);
      break;
    case "execution.commit-peer-delegation":
      result = commitPeerDelegation(draft, command.request);
      break;
    case "execution.commit-peer-evidence":
      result = commitPeerEvidence(draft, command.request);
      break;
    case "execution.report-peer-loss":
      result = reportPeerLoss(draft, command.request);
      break;
    case "execution.reserve-pull":
      result = reservePull(draft, command.request);
      break;
    case "execution.accept-preparation":
      result = acceptPreparation(draft, command.request);
      break;
    case "execution.accept-assistant-partial":
      result = acceptAssistantPartial(draft, command.request);
      break;
    case "execution.resolve-pull":
      result = resolvePull(draft, command.request);
      break;
    case "execution.append-emission":
      result = appendEmission(draft, command.request);
      break;
    case "execution.complete-task":
      result = completeTask(draft, command.request);
      break;
    case "execution.request-cancellation":
      result = requestCancellation(
        draft,
        command.request.sessionId,
        command.request.taskId,
        command.request.reason,
        command.request.commandId,
      );
      break;
    case "execution.begin-cancellation-unwind":
      result = beginCancellationUnwind(draft, command.request);
      break;
    case "execution.detach-attempt":
      result = detachAttempt(draft, command.request);
      break;
    case "execution.abandon-attempt":
      result = abandonAttempt(draft, command.request);
      break;
    case "execution.force-orphan":
      result = forceOrphan(draft, command.request);
      break;
    case "control.claim-activation":
      result = claimActivation(draft, command.request);
      break;
    case "control.renew-activation":
      result = renewActivation(draft, command.request);
      break;
    case "control.release-activation":
      result = releaseActivation(draft, command.request);
      break;
    case "recovery.issue-ticket":
      result = issueRestoreTicket(draft, command.request);
      break;
    case "recovery.prepare-restore":
      result = prepareRestore(draft, command.request);
      break;
    case "recovery.bind-frontier":
      result = bindFrontier(draft, command.request);
      break;
    case "recovery.consume-ticket":
      result = consumeTicket(draft, command.request);
      break;
    default:
      return assertNever(command);
  }
  return result as CommandResult<C>;
}

function openTask(
  draft: DecisionDraft,
  request: OpenDurableTaskRequest,
): { programCapability: string } {
  const session = draft.session(request.sessionId);
  if (session.execution.tasks.has(request.taskId))
    throw new CrankError("invalid_journal", "Task already exists");
  const input = draft.parseSchema(
    request.manifest.inputSchema.digest,
    request.input,
    "invalid_descriptor",
  );
  assertInlineSize(input, draft.maxOutcomeBytes);
  assertEffectContractsCompatible(draft.state, request.manifest);
  if ((request.catalog === undefined) !== (request.catalogDigest === undefined)) {
    throw new CrankError(
      "invalid_manifest",
      "Catalog and catalog digest must be supplied together",
    );
  }
  const catalog =
    request.catalog === undefined ? undefined : canonicalSnapshot(request.catalog).value;
  if (
    catalog !== undefined &&
    (typeof catalog !== "object" ||
      Array.isArray(catalog) ||
      (catalog as Record<string, Json>)["digest"] !== request.catalogDigest)
  )
    throw new CrankError("invalid_manifest", "Accepted catalog digest differs");
  if (catalog !== undefined) assertInlineSize(catalog, draft.maxOutcomeBytes);
  const origin = request.parentTaskId
    ? {
        kind: "child" as const,
        invokedBy: { taskId: request.parentTaskId, pullId: request.parentPullId! },
      }
    : { kind: "root" as const };
  // Expiry caps flow downward (REQ-030): explicit policies resolve against the
  // ancestor cap; descendants without one inherit it; roots without one carry
  // no policy, so a later `inherit` fork admission fails closed.
  let deadlineMs: number | undefined;
  if (request.expiryPolicy !== undefined) {
    const ancestor =
      request.parentTaskId === undefined
        ? undefined
        : draft.task(request.sessionId, request.parentTaskId).deadlineMs;
    deadlineMs = resolveForkDeadline(request.expiryPolicy, ancestor, draft.context.nowMs);
  } else if (request.parentTaskId !== undefined) {
    deadlineMs = draft.task(request.sessionId, request.parentTaskId).deadlineMs;
  }
  const task: DraftTask = {
    taskId: request.taskId,
    turnId: request.turnId,
    origin,
    ...(deadlineMs === undefined ? {} : { deadlineMs }),
    program: {
      artifact: {
        id: request.manifest.programId,
        version: request.manifest.version,
        digest: request.manifest.digest,
      },
      manifest: structuredClone(request.manifest),
      input,
    },
    execution: {
      epoch: request.executionEpoch,
      attachmentId: request.attachmentId,
      audience: request.audience,
      ...(request.elicitAudience === undefined ? {} : { elicitAudience: request.elicitAudience }),
      ...(request.route === undefined ? {} : { route: structuredClone(request.route) }),
      ...(catalog === undefined ? {} : { catalog, catalogDigest: request.catalogDigest! }),
    },
    actions: [],
    nextActionIndex: 0,
    nextPullIndex: 0,
    nextEmissionIndex: 0,
    ...(draft.emissionPolicy === undefined
      ? {}
      : {
          emissionPolicy: structuredClone(draft.emissionPolicy),
        }),
    acceptedEmissionCount: 0,
    cumulativeEmissionBytes: 0,
    lifecycle: { status: "active", cancellation: { type: "none" } },
  };
  session.execution.tasks.set(request.taskId, task);
  draft.append(request.sessionId, request.executionEpoch, {
    type: "TaskOpened",
    taskId: request.taskId,
    turnId: request.turnId,
    programId: request.manifest.programId,
    programVersion: request.manifest.version,
    programDigest: request.manifest.digest,
    input,
    inputDigest: canonicalSnapshot(input).sha,
    ...(catalog === undefined ? {} : { catalog, catalogDigest: request.catalogDigest! }),
    ...(request.parentTaskId === undefined ? {} : { parentTaskId: request.parentTaskId }),
    ...(request.parentPullId === undefined ? {} : { parentPullId: request.parentPullId }),
    ...(request.elicitAudience === undefined ? {} : { elicitAudience: request.elicitAudience }),
  });
  session.control.runnable = true;
  return { programCapability: draft.programCapability(task) };
}

function bindAttachment(
  draft: DecisionDraft,
  request: { sessionId: string; taskId: string; attachmentId: string; executionEpoch: number },
): { programCapability: string } {
  const session = draft.session(request.sessionId);
  const task = draft.task(request.sessionId, request.taskId);
  draft.assertActive(task);
  session.control.runnable = false;
  if (task.execution.epoch !== request.executionEpoch)
    throw new CrankError("stale_program_capability");
  if (task.execution.attachmentId !== request.attachmentId) {
    detachTaskAttempts(draft, request.sessionId, task, "attachment_replaced");
    task.execution.attachmentId = request.attachmentId;
  }
  return { programCapability: draft.programCapability(task) };
}

function replaceAttachment(
  draft: DecisionDraft,
  request: { sessionId: string; taskId: string; attachmentId: string; audience?: string },
): { executionEpoch: number; programCapability: string } {
  const session = draft.session(request.sessionId);
  const lease = session.control.activationLease;
  if (lease && draft.context.nowMs < lease.expiresAtMs) {
    throw new CrankError(
      "stale_activation",
      "replaceAttachment is not valid for an unexpired lease-managed session",
    );
  }
  if (lease) {
    delete session.control.activationLease;
    session.control.runnable = true;
  }
  const task = draft.task(request.sessionId, request.taskId);
  draft.assertActive(task);
  detachTaskAttempts(draft, request.sessionId, task, "attachment_replaced");
  task.execution.epoch += 1;
  task.execution.attachmentId = request.attachmentId;
  if (request.audience !== undefined) task.execution.audience = request.audience;
  return { executionEpoch: task.execution.epoch, programCapability: draft.programCapability(task) };
}

function ensureChild(draft: DecisionDraft, request: EnsureChildTaskRequest): EnsureChildTaskResult {
  const parent = draft.task(request.sessionId, request.parentTaskId);
  draft.assertActive(parent);
  const parentPull = pullById(parent, request.parentPullId);
  if (parentPull.request.acceptedDescriptor.kind !== "invoke") {
    throw new CrankError("invalid_descriptor", "Parent pull is not a child invocation");
  }
  const expected = parentPull.request.acceptedDescriptor.child;
  if (
    expected.id !== request.child.id ||
    expected.version !== request.child.version ||
    expected.digest !== request.child.digest ||
    canonicalSnapshot(expected.input).sha !== canonicalSnapshot(request.child.input).sha
  )
    throw new CrankError("nondeterminism_detected", "Child descriptor differs from parent pull");
  const existing = [...draft.session(request.sessionId).execution.tasks.values()].find(
    (task) =>
      task.origin.kind === "child" &&
      task.origin.invokedBy.taskId === request.parentTaskId &&
      task.origin.invokedBy.pullId === request.parentPullId,
  );
  if (existing) {
    if (
      existing.program.artifact.id !== request.manifest.programId ||
      existing.program.artifact.version !== request.manifest.version ||
      existing.program.artifact.digest !== request.manifest.digest
    ) {
      throw new CrankError("program_version_mismatch");
    }
    const outcome = terminalOutcome(existing);
    return outcome === undefined
      ? { taskId: existing.taskId }
      : { taskId: existing.taskId, outcome };
  }
  const ordinal = [...draft.session(request.sessionId).execution.tasks.values()].filter(
    (task) => task.origin.kind === "child" && task.origin.invokedBy.taskId === request.parentTaskId,
  ).length;
  const taskId = `${request.parentTaskId}.${ordinal}`;
  openTask(draft, {
    sessionId: request.sessionId,
    turnId: request.turnId,
    taskId,
    manifest: request.manifest,
    input: request.child.input,
    executionEpoch: request.executionEpoch,
    attachmentId: "unattached-child",
    audience: request.audience,
    ...(parent.execution.elicitAudience === undefined
      ? {}
      : { elicitAudience: parent.execution.elicitAudience }),
    ...(parent.execution.catalog === undefined
      ? {}
      : { catalog: parent.execution.catalog, catalogDigest: parent.execution.catalogDigest! }),
    ...(request.route === undefined ? {} : { route: request.route }),
    parentTaskId: request.parentTaskId,
    parentPullId: request.parentPullId,
  });
  return { taskId };
}

type ForkDescriptorPayload =
  | (DurableAllDescriptor & { readonly children: readonly DurableChildDescriptor[] })
  | (DurableRaceDescriptor & { readonly children: readonly DurableChildDescriptor[] });

/**
 * Atomic fork-group admission (REQ-021/023/030). Opens the group row and
 * every member row in one commit; identical retries return the recorded
 * opening; a second distinct group on a nonterminal pull is refused.
 */
function openForkGroup(draft: DecisionDraft, request: OpenForkGroupRequest): OpenForkGroupResult {
  const parent = draft.task(request.sessionId, request.parentTaskId);
  draft.assertActive(parent);
  const pull = pullById(parent, request.parentPullId);
  const kind = pull.request.acceptedDescriptor.kind;
  if (kind !== "all" && kind !== "race") {
    throw new CrankError("invalid_descriptor", "Parent pull is not a fork descriptor");
  }
  const descriptor = pull.request.acceptedDescriptor as unknown as ForkDescriptorPayload;
  const descriptorDigest = pull.request.proposedDescriptorDigest;
  const existing = parent.forkGroup;
  if (existing !== undefined && existing.status !== "resolved") {
    if (existing.pullId === pull.pullId && existing.descriptorDigest === descriptorDigest) {
      return {
        status: "duplicate",
        groupId: existing.groupId,
        deadlineMs: existing.deadlineMs,
        memberTaskIds: existing.members.map((member) => member.taskId),
      };
    }
    throw new CrankError("fork_group_open", "Task already has an open fork group");
  }
  const policy: ForkPolicy =
    kind === "all"
      ? { mode: "all", supervision: "one_for_all" }
      : { mode: "race", supervision: "first_success" };
  assertForkPolicyPairing(policy);
  if (request.members.length !== descriptor.children.length) {
    throw new CrankError("nondeterminism_detected", "Fork members differ from the descriptor");
  }
  for (const [index, member] of request.members.entries()) {
    const expected = descriptor.children[index]!;
    if (
      expected.id !== member.child.id ||
      expected.version !== member.child.version ||
      expected.digest !== member.child.digest ||
      canonicalSnapshot(expected.input).sha !== canonicalSnapshot(member.child.input).sha
    ) {
      throw new CrankError("nondeterminism_detected", "Fork member differs from the descriptor");
    }
  }
  // Closed durability union with declared peer sampling (REQ-035, REQ-042):
  // admission fails closed on unknown classes and missing declarations.
  for (const child of descriptor.children) {
    const durability = child.durability;
    if (durability === undefined || durability.kind === "crank_native") continue;
    if (durability.kind === "peer_hosted") {
      if (
        typeof durability.peer !== "string" ||
        durability.peer.length === 0 ||
        (durability.sampling !== "delegated" && durability.sampling !== "private")
      ) {
        throw new CrankError(
          "invalid_descriptor",
          "Peer-hosted members require a declared sampling mode",
        );
      }
      continue;
    }
    throw new CrankError("invalid_descriptor", "Unknown member durability class");
  }
  const deadlineMs = resolveForkDeadline(
    descriptor.expiry,
    parent.deadlineMs,
    draft.context.nowMs,
  );
  const groupId = forkGroupIdFor(parent.taskId, pull.pullId);
  const baseOrdinal = [...draft.session(request.sessionId).execution.tasks.values()].filter(
    (task) => task.origin.kind === "child" && task.origin.invokedBy.taskId === parent.taskId,
  ).length;
  const memberTaskIds = request.members.map((_, index) => `${parent.taskId}.${baseOrdinal + index}`);
  const group: DeepMutable<ForkGroupState> = {
    groupId,
    parentTaskId: parent.taskId,
    pullId: pull.pullId,
    descriptorDigest,
    policy,
    deadlineMs,
    members: request.members.map((_, index) => {
      const durability = descriptor.children[index]!.durability;
      return durability?.kind === "peer_hosted"
        ? {
            ordinal: index,
            taskId: memberTaskIds[index]!,
            durability: "peer_hosted" as const,
            peer: durability.peer,
            sampling: durability.sampling,
          }
        : { ordinal: index, taskId: memberTaskIds[index]!, durability: "crank_native" as const };
    }),
    status: "open",
  };
  for (const [index, member] of request.members.entries()) {
    const durability = descriptor.children[index]!.durability;
    openTask(draft, {
      sessionId: request.sessionId,
      turnId: request.turnId,
      taskId: memberTaskIds[index]!,
      manifest: member.manifest,
      input: member.child.input,
      executionEpoch: request.executionEpoch,
      attachmentId: "unattached-child",
      // Peer member audiences are derived locally, never taken from
      // peer-supplied claims (REQ-041).
      audience:
        durability?.kind === "peer_hosted" ? `peer:${durability.peer}` : request.audience,
      ...(parent.execution.elicitAudience === undefined
        ? {}
        : { elicitAudience: parent.execution.elicitAudience }),
      ...(parent.execution.catalog === undefined
        ? {}
        : { catalog: parent.execution.catalog, catalogDigest: parent.execution.catalogDigest! }),
      ...(member.route === undefined ? {} : { route: member.route }),
      parentTaskId: parent.taskId,
      parentPullId: pull.pullId,
      expiryPolicy: { kind: "at", atMs: deadlineMs },
    });
  }
  parent.forkGroup = group;
  draft.append(request.sessionId, parent.execution.epoch, {
    type: "ForkGroupOpened",
    taskId: parent.taskId,
    pullId: pull.pullId,
    groupId,
    policy,
    deadlineMs,
    memberTaskIds,
    descriptorDigest,
  });
  draft.session(request.sessionId).control.runnable = true;
  return { status: "opened", groupId, deadlineMs, memberTaskIds };
}

/**
 * Clock-driven expiry breach (REQ-031): commits an auditable breach record,
 * starts leaves-first member cancellation, and resolves `expired` only once
 * every member is terminal. Loses to an earlier resolution with a typed
 * `fork_group_terminal` rejection (REQ-032); a breach committed first makes
 * later member successes member history only.
 */
function breachForkGroup(
  draft: DecisionDraft,
  request: BreachForkGroupRequest,
): BreachForkGroupResult {
  const parent = draft.task(request.sessionId, request.taskId);
  const group = parent.forkGroup;
  if (group === undefined || group.groupId !== request.groupId) {
    throw new CrankError("invalid_journal", "Unknown fork group");
  }
  if (group.status === "resolved") {
    throw new CrankError("fork_group_terminal", "Fork group already resolved");
  }
  if (draft.context.nowMs < group.deadlineMs) {
    throw new CrankError("fork_group_unexpired", "Fork group deadline has not elapsed");
  }
  let cancelMembers: readonly string[] = [];
  if (group.breachedAtMs === undefined) {
    group.breachedAtMs = draft.context.nowMs;
    draft.append(request.sessionId, parent.execution.epoch, {
      type: "ForkGroupBreached",
      taskId: parent.taskId,
      groupId: group.groupId,
      deadlineMs: group.deadlineMs,
      breachedAtMs: draft.context.nowMs,
    });
    cancelMembers = beginForkGroupCancellation(group, "expiry");
    for (const memberTaskId of cancelMembers) {
      requestCancellation(draft, request.sessionId, memberTaskId, "fork_group_expired");
    }
  }
  const resolution = drainForkGroup(group);
  if (resolution !== undefined) {
    draft.append(request.sessionId, parent.execution.epoch, {
      type: "ForkGroupResolved",
      taskId: parent.taskId,
      pullId: group.pullId,
      groupId: group.groupId,
      terminal: resolution,
      terminalDigest: canonicalSnapshot(resolution).sha,
    });
    settlePullWithOutcome(
      draft,
      request.sessionId,
      parent,
      pullById(parent, group.pullId),
      parent.execution.epoch,
      forkGroupOutcome(resolution),
    );
  }
  return {
    groupId: group.groupId,
    cancelMembers,
    ...(resolution === undefined ? {} : { resolution }),
  };
}

/**
 * Separately authorized force-orphan of a stuck group (REQ-034). Honest:
 * records `orphaned` and never fabricates another ending; nonterminal
 * members are orphaned in place; later member messages stay opaque evidence.
 */
function forceOrphanForkGroup(
  draft: DecisionDraft,
  request: ForceOrphanForkGroupRequest,
): ForceOrphanForkGroupResult {
  const parent = draft.task(request.sessionId, request.taskId);
  const group = parent.forkGroup;
  if (group === undefined || group.groupId !== request.groupId) {
    throw new CrankError("invalid_journal", "Unknown fork group");
  }
  if (group.status !== "cancelling") {
    throw new CrankError(
      group.status === "resolved" ? "fork_group_terminal" : "fork_group_not_cancelling",
      "Force-orphan requires a stuck cancelling fork group",
    );
  }
  const resolution = forceOrphanForkGroupResolution(group, request.reason);
  for (const member of group.members) {
    if (member.terminal !== undefined) continue;
    const memberTask = draft.task(request.sessionId, member.taskId);
    if (memberTask.lifecycle.status !== "active") continue;
    memberTask.lifecycle = { status: "orphaned", reason: "cleanup_stuck" };
    draft.append(request.sessionId, memberTask.execution.epoch, {
      type: "TaskOrphaned",
      taskId: member.taskId,
      reason: "cleanup_stuck",
    });
  }
  draft.append(request.sessionId, parent.execution.epoch, {
    type: "ForkGroupOrphaned",
    taskId: parent.taskId,
    pullId: group.pullId,
    groupId: group.groupId,
    reason: request.reason,
  });
  draft.append(request.sessionId, parent.execution.epoch, {
    type: "ForkGroupResolved",
    taskId: parent.taskId,
    pullId: group.pullId,
    groupId: group.groupId,
    terminal: resolution,
    terminalDigest: canonicalSnapshot(resolution).sha,
  });
  settlePullWithOutcome(
    draft,
    request.sessionId,
    parent,
    pullById(parent, group.pullId),
    parent.execution.epoch,
    forkGroupOutcome(resolution),
  );
  return { resolution };
}

function peerMemberOf(
  group: DeepMutable<ForkGroupState>,
  memberTaskId: string,
): DeepMutable<ForkGroupState>["members"][number] {
  const member = group.members.find((entry) => entry.taskId === memberTaskId);
  if (member === undefined) {
    throw new CrankError("invalid_journal", `Task ${memberTaskId} is not a fork group member`);
  }
  if (member.durability !== "peer_hosted") {
    throw new CrankError("invalid_descriptor", `Member ${memberTaskId} is not peer-hosted`);
  }
  return member;
}

function groupForRequest(
  draft: DecisionDraft,
  sessionId: string,
  taskId: string,
  groupId: string,
): { parent: DraftTask; group: DeepMutable<ForkGroupState> } {
  const parent = draft.task(sessionId, taskId);
  const group = parent.forkGroup;
  if (group === undefined || group.groupId !== groupId) {
    throw new CrankError("invalid_journal", "Unknown fork group");
  }
  return { parent, group };
}

function mintDeliveryMandate(
  draft: DecisionDraft,
  sessionId: string,
  parent: DraftTask,
  group: DeepMutable<ForkGroupState>,
  memberTaskId: string,
  correlator: string,
  peer: string,
): string {
  return signCapability(
    {
      journalId: draft.context.journalIdentity.id,
      journalIncarnation: draft.context.journalIdentity.incarnation,
      sessionId,
      taskId: parent.taskId,
      groupId: group.groupId,
      memberTaskId,
      correlator,
      audience: `peer:${peer}`,
      permissions: ["deliver"],
      // Deterministic: duplicate delegation retries mint the identical
      // mandate without consuming journal nonce state.
      nonce: stableTupleHash(["delivery-mandate", correlator]),
    },
    draft.context.keyring,
  );
}

/**
 * Journal-first peer delegation (REQ-038): the delivery record commits before
 * any send; the correlator is deterministic, so retries reuse it and peers
 * dedupe by it (REQ-039). The returned DeliveryMandate confers proposal
 * rights only (REQ-074).
 */
function commitPeerDelegation(
  draft: DecisionDraft,
  request: CommitPeerDelegationRequest,
): CommitPeerDelegationResult {
  const { parent, group } = groupForRequest(draft, request.sessionId, request.taskId, request.groupId);
  if (group.status === "resolved") {
    throw new CrankError("fork_group_terminal", "Fork group already resolved");
  }
  const member = peerMemberOf(group, request.memberTaskId);
  const correlator = peerDeliveryCorrelator(group.groupId, member.taskId);
  const mandate = mintDeliveryMandate(
    draft,
    request.sessionId,
    parent,
    group,
    member.taskId,
    correlator,
    member.peer!,
  );
  if (member.delegationCorrelator !== undefined) {
    if (member.delegationCorrelator !== correlator) {
      throw new CrankError("nondeterminism_detected", "Peer delegation correlator differs");
    }
    return { status: "duplicate", correlator, deliveryMandate: mandate };
  }
  member.delegationCorrelator = correlator;
  draft.append(request.sessionId, parent.execution.epoch, {
    type: "PeerDelegationCommitted",
    taskId: parent.taskId,
    groupId: group.groupId,
    memberTaskId: member.taskId,
    correlator,
    peer: member.peer!,
    deadlineMs: group.deadlineMs,
  });
  draft.session(request.sessionId).control.runnable = true;
  return { status: "committed", correlator, deliveryMandate: mandate };
}

/**
 * Closes a peer member from external evidence. Invariant P (REQ-075): the
 * member row holds a structural task and evidence only — no local attempt
 * ever exists on it, and the evidence commits through the ordinary group
 * reducer so supervision stays exact (REQ-043).
 */
function closePeerMember(
  draft: DecisionDraft,
  sessionId: string,
  group: DeepMutable<ForkGroupState>,
  memberTaskId: string,
  correlator: string,
  mandate: string,
  outcome: OperationOutcome,
): void {
  const member = peerMemberOf(group, memberTaskId);
  verifyDeliveryMandate(mandate, draft.context.keyring, {
    journalId: draft.context.journalIdentity.id,
    journalIncarnation: draft.context.journalIdentity.incarnation,
    sessionId,
    groupId: group.groupId,
    memberTaskId,
    correlator,
  });
  if (member.delegationCorrelator !== correlator) {
    throw new CrankError("invalid_delivery_mandate", "Unknown delivery correlator");
  }
  const memberTask = draft.task(sessionId, member.taskId);
  if (memberTask.lifecycle.status !== "active") {
    // First-committed-wins (REQ-032): the accepted fact is never rewritten.
    throw new CrankError("fork_member_terminal", "Peer member is already terminal");
  }
  const offset = draft.append(sessionId, memberTask.execution.epoch, {
    type: "TaskClosed",
    taskId: member.taskId,
    outcome,
  });
  memberTask.lifecycle =
    outcome.status === "cancelled"
      ? {
          status: "cancelled",
          outcome,
          receipt: { offset, duplicate: false },
          commandId: stableTupleHash(["peer-cancel", correlator]),
        }
      : { status: "closed", outcome, receipt: { offset, duplicate: false } };
  settleParentFromChild(draft, sessionId, memberTask, outcome);
}

function commitPeerEvidence(
  draft: DecisionDraft,
  request: CommitPeerEvidenceRequest,
): CommitPeerEvidenceResult {
  const { group } = groupForRequest(draft, request.sessionId, request.taskId, request.groupId);
  closePeerMember(
    draft,
    request.sessionId,
    group,
    request.memberTaskId,
    request.correlator,
    request.deliveryMandate,
    request.outcome,
  );
  return { status: "accepted" };
}

/** Typed peer loss (REQ-043): a journaled `peer_lost` member outcome that
 *  flows through supervision, never a dangling member. */
function reportPeerLoss(
  draft: DecisionDraft,
  request: ReportPeerLossRequest,
): ReportPeerLossResult {
  const { group } = groupForRequest(draft, request.sessionId, request.taskId, request.groupId);
  closePeerMember(
    draft,
    request.sessionId,
    group,
    request.memberTaskId,
    request.correlator,
    request.deliveryMandate,
    peerLossOutcome(request.reason),
  );
  return { status: "accepted" };
}

function reservePull(
  draft: DecisionDraft,
  request: ReserveOperationRequest,
): ReserveOperationResult {
  const task = draft.task(request.sessionId, request.taskId);
  draft.assertProgram(request.programCapability, task, request.sessionId);
  draft.assertActive(task);
  if (request.turnId !== task.turnId)
    throw new CrankError("invalid_descriptor", "Turn identity mismatch");
  const descriptor = snapshotDescriptor(request.descriptor);
  const descriptorDigest = canonicalSnapshot(descriptor).sha;
  const existingAction = task.actions.find(
    (action) => action.kind === "pull" && action.actionIndex === request.actionIndex,
  );
  const existing = existingAction?.kind === "pull" ? (existingAction.pull as DraftPull) : undefined;
  if (existing) {
    if (
      existing.request.proposedDescriptorDigest !== descriptorDigest ||
      existingAction?.kind !== "pull" ||
      existingAction.pullIndex !== request.pullIndex
    ) {
      throw new CrankError("nondeterminism_detected", "Recorded operation descriptor differs");
    }
    if (existing.resolution.status === "settled") {
      return {
        status: "resolved",
        outcome: structuredClone(existing.resolution.settlement.outcome),
        receipt: { ...existing.resolution.settlement.receipt, status: "duplicate" },
      };
    }
    if (descriptor.kind === "effect" || descriptor.kind === "record")
      return authorizeExisting(draft, task, existing);
    const capability =
      existing.resolutionAuthority.kind === "attempt"
        ? draft.resolutionCapability(task, existing, undefined)
        : existing.resolutionAuthority.capability;
    if (existing.resolutionAuthority.kind !== "attempt")
      existing.resolutionAuthority = {
        ...existing.resolutionAuthority,
        capability,
      } as ResolutionAuthority;
    return {
      status: "pending",
      pullId: existing.pullId,
      reason: pendingReason(descriptor),
      resolutionCapability: capability,
    };
  }
  if (
    task.lifecycle.status === "active" &&
    task.lifecycle.cancellation.type !== "none" &&
    task.lifecycle.cancellation.type !== "unwinding" &&
    request.actionIndex >= task.lifecycle.cancellation.frontier.actionIndex
  )
    throw new CrankError("cancellation_blocked");
  // Ancestor freeze (REQ-021): no new work while a fork group is nonterminal.
  if (task.forkGroup !== undefined && task.forkGroup.status !== "resolved")
    throw new CrankError("fork_group_open", "Task is frozen by an open fork group");
  if (request.actionIndex !== task.nextActionIndex || request.pullIndex !== task.nextPullIndex) {
    throw new CrankError("nondeterminism_detected", "Task-local action or pull cursor mismatch");
  }
  if (
    descriptor.kind === "elicit" &&
    openElicitCount(draft.state, request.sessionId) >= MAX_OPEN_ELICITATIONS
  ) {
    throw new CrankError("checkpoint_bound_exceeded");
  }
  const policy = operationPolicy(task.program.manifest, descriptor);
  let effectiveDescriptor = descriptor;
  if (descriptor.kind === "wait" && descriptor.durationMs !== undefined) {
    effectiveDescriptor = {
      ...descriptor,
      notBefore: new Date(draft.context.nowMs + descriptor.durationMs).toISOString(),
    };
  }
  if (
    policy.inputDigest !== undefined &&
    (descriptor.kind === "effect" || descriptor.kind === "sample")
  ) {
    effectiveDescriptor = {
      ...descriptor,
      input: draft.parseSchema(policy.inputDigest, descriptor.input, "invalid_descriptor"),
    };
  }
  if (descriptor.kind === "elicit" && policy.contextDigest && descriptor.context !== undefined) {
    effectiveDescriptor = {
      ...descriptor,
      context: draft.parseSchema(policy.contextDigest, descriptor.context, "invalid_descriptor"),
    };
  }
  if (request.restoredFrontier !== undefined) {
    consumeRestoredFrontier(
      draft,
      request.sessionId,
      task,
      request.restoredFrontier,
      request.restoredFrontierStep,
    );
  }
  const pullId = stableTupleHash([
    "pull",
    request.sessionId,
    request.turnId,
    request.taskId,
    request.pullIndex,
  ]);
  const publicMessageId = isModelSampleDescriptor(descriptor)
    ? stableTupleHash(["sweatpants.public-assistant", pullId])
    : undefined;
  const pull: DraftPull = {
    pullId,
    request: {
      proposedDescriptorDigest: descriptorDigest,
      proposedDescriptor: descriptor,
      acceptedDescriptor: effectiveDescriptor,
      resultDescriptor: policy.resultDescriptor,
      resultSchemaDigest: policy.resultDescriptor.digest,
      maxOutcomeBytes: draft.maxOutcomeBytes,
      ...(publicMessageId === undefined ? {} : { publicMessageId }),
    },
    resolutionAuthority: executableDescriptor(effectiveDescriptor)
      ? {
          kind: "attempt",
          owner: effectiveDescriptor.kind === "record" ? "program" : "effect",
          audience: policy.audience,
        }
      : pendingResolutionAuthority(
          effectiveDescriptor,
          descriptor.kind === "elicit"
            ? (task.execution.elicitAudience ?? policy.audience)
            : policy.audience,
        ),
    attempts: [],
    acceptedFacts: {},
    resolution: { status: "open", revoked: false },
  };
  task.actions.push({
    kind: "pull",
    actionIndex: request.actionIndex,
    pullIndex: request.pullIndex,
    pull,
  });
  task.nextPullIndex += 1;
  draft.append(request.sessionId, task.execution.epoch, {
    type: "PullRequested",
    taskId: task.taskId,
    turnId: task.turnId,
    actionIndex: request.actionIndex,
    pullIndex: request.pullIndex,
    pullId,
    descriptor,
    descriptorDigest,
    ...(publicMessageId === undefined ? {} : { publicMessageId }),
  });
  if (executableDescriptor(effectiveDescriptor)) {
    const authorized = startAttempt(draft, task, pull);
    return {
      ...authorized,
      ...(request.restoredFrontier === undefined
        ? {}
        : { restoredFrontierConsumed: true as const }),
    };
  }
  const capability = draft.resolutionCapability(task, pull, undefined);
  if (pull.resolutionAuthority.kind === "participant") {
    pull.resolutionAuthority = { ...pull.resolutionAuthority, capability };
  } else if (pull.resolutionAuthority.kind === "clock") {
    pull.resolutionAuthority = { ...pull.resolutionAuthority, capability };
  } else if (pull.resolutionAuthority.kind === "child") {
    pull.resolutionAuthority = { ...pull.resolutionAuthority, capability };
  }
  return {
    status: "pending",
    pullId,
    reason: pendingReason(descriptor),
    resolutionCapability: capability,
    ...(request.restoredFrontier === undefined ? {} : { restoredFrontierConsumed: true as const }),
  };
}

function matchesModelPreparationOwner(
  task: DraftTask,
  pull: DraftPull,
  expectedOwnerFence: string,
): boolean {
  const attempt = currentAttempt(pull);
  return attempt
    ? attempt.attemptId === expectedOwnerFence
    : pull.request.proposedDescriptor.kind === "sample" &&
        expectedOwnerFence === modelPullOwnerFence(pull.pullId, task.execution.epoch);
}

function acceptPreparation(
  draft: DecisionDraft,
  request: AcceptPullPreparationRequest,
): AcceptPullPreparationResult {
  if (
    request.kind !== "model-context" ||
    request.fact.type !== "ModelContextPrepared" ||
    request.fact.taskId !== request.taskId ||
    request.fact.pullId !== request.pullId ||
    request.fact.executionId !== request.executionId
  )
    return { status: "identity_conflict" };
  const found = findTaskPullById(draft.state, request.taskId, request.pullId);
  if (!found) return { status: "pull_not_pending" };
  const [sessionId, task, pull] = found;
  if (
    task.lifecycle.status !== "active" ||
    pull.resolution.status !== "open" ||
    pull.resolution.revoked
  )
    return { status: "pull_not_pending" };
  if (!isModelSampleDescriptor(pull.request.proposedDescriptor))
    return { status: "identity_conflict" };
  if (!matchesModelPreparationOwner(task, pull, request.expectedOwnerFence))
    return { status: "stale_owner" };
  const digest = canonicalSnapshot(request.fact).sha;
  if (pull.acceptedFacts.preparation)
    return pull.acceptedFacts.preparationDigest === digest
      ? { status: "duplicate" }
      : {
          status: "identity_conflict",
          conflict: identityConflict(
            "model-context",
            `${request.executionId}/${request.taskId}/${request.pullId}`,
            digest,
            pull.acceptedFacts.preparationDigest ?? null,
          ),
        };
  pull.acceptedFacts.preparation = structuredClone(request.fact) as NonNullable<
    DraftPull["acceptedFacts"]["preparation"]
  >;
  pull.acceptedFacts.preparationDigest = digest;
  draft.append(sessionId, task.execution.epoch, {
    type: "ModelContextPrepared",
    taskId: request.taskId,
    pullId: request.pullId,
    attemptId: request.expectedOwnerFence,
    fact: request.fact,
    preparationDigest: digest,
  });
  return { status: "accepted" };
}

function authorizeModelDispatch(
  state: AuthorityState,
  request: AuthorizeModelDispatchRequest,
): AuthorizeModelDispatchResult {
  const found = findTaskPullById(state, request.taskId, request.pullId);
  if (!found) return { status: "pull_not_pending" };
  const [, task, pull] = found;
  if (
    task.lifecycle.status !== "active" ||
    pull.resolution.status !== "open" ||
    pull.resolution.revoked
  )
    return { status: "pull_not_pending" };
  if (!isModelSampleDescriptor(pull.request.proposedDescriptor))
    return { status: "identity_conflict" };
  if (!matchesModelPreparationOwner(task, pull, request.expectedOwnerFence))
    return { status: "stale_owner" };
  const preparation = pull.acceptedFacts.preparation;
  if (!preparation) return { status: "not_prepared" };
  if (preparation.executionId !== request.executionId) return { status: "identity_conflict" };
  if (preparation.invocationDigest !== request.invocationDigest)
    return {
      status: "identity_conflict",
      conflict: identityConflict(
        "model-context",
        `${request.executionId}/${request.taskId}/${request.pullId}`,
        request.invocationDigest,
        preparation.invocationDigest,
      ),
    };
  return { status: "authorized", fact: structuredClone(preparation) };
}

function acceptAssistantPartial(
  draft: DecisionDraft,
  request: AcceptAssistantPartialRequest,
): AcceptAssistantPartialResult {
  const found = findTaskPullById(draft.state, request.taskId, request.pullId);
  if (!found) return { status: "pull_not_pending" };
  const [sessionId, task, pull] = found;
  if (
    task.lifecycle.status !== "active" ||
    pull.resolution.status !== "open" ||
    pull.resolution.revoked
  )
    return { status: "pull_not_pending" };
  if (!isModelSampleDescriptor(pull.request.proposedDescriptor))
    return { status: "identity_conflict" };
  if (!matchesModelPreparationOwner(task, pull, request.expectedOwnerFence))
    return { status: "stale_owner" };
  if (pull.acceptedFacts.preparation?.executionId !== request.executionId)
    return { status: "identity_conflict" };
  if (
    !pull.acceptedFacts.preparation ||
    pull.acceptedFacts.preparation.publicMessageId !== request.fact.messageId ||
    request.fact.text.length === 0 ||
    request.fact.text.length > 32_768
  )
    return { status: "identity_conflict" };
  const digest = canonicalSnapshot(request.fact).sha;
  if (pull.acceptedFacts.assistantPartial)
    return pull.acceptedFacts.assistantPartialDigest === digest
      ? { status: "duplicate" }
      : {
          status: "identity_conflict",
          conflict: identityConflict(
            "assistant-partial",
            `${request.executionId}/${request.taskId}/${request.pullId}`,
            digest,
            pull.acceptedFacts.assistantPartialDigest ?? null,
          ),
        };
  pull.acceptedFacts.assistantPartial = structuredClone(request.fact);
  pull.acceptedFacts.assistantPartialDigest = digest;
  draft.append(sessionId, task.execution.epoch, {
    type: "AssistantPartialAccepted",
    taskId: request.taskId,
    pullId: request.pullId,
    attemptId: request.expectedOwnerFence,
    fact: request.fact,
    factDigest: digest,
  });
  return { status: "accepted" };
}

function resolvePull(
  draft: DecisionDraft,
  request: ResolveOperationRequest,
): ResolveOperationResult {
  let claims;
  try {
    claims = verifyResolutionCapability(
      request.capability,
      draft.context.keyring,
      request.audience,
    );
  } catch (error) {
    return {
      status: "rejected",
      code:
        error instanceof CrankError && error.code === "wrong_audience"
          ? "wrong_audience"
          : "invalid_resolution_capability",
    };
  }
  if (
    claims.journalId !== draft.context.journalIdentity.id ||
    claims.journalIncarnation !== draft.context.journalIdentity.incarnation
  )
    return { status: "rejected", code: "invalid_resolution_capability" };
  const task = draft.state.sessions.get(claims.sessionId)?.execution.tasks.get(claims.taskId) as
    | DraftTask
    | undefined;
  if (!task) return { status: "rejected", code: "pull_not_found" };
  let pull: DraftPull;
  try {
    pull = pullById(task, claims.pullId);
  } catch {
    return { status: "rejected", code: "pull_not_found" };
  }
  const attempt =
    claims.attemptId === "none"
      ? undefined
      : pull.attempts.find((candidate) => candidate.attemptId === claims.attemptId);
  const reject = (): Extract<ResolveOperationResult, { status: "rejected" }> | undefined => {
    if (
      pull.request.proposedDescriptorDigest !== claims.descriptorDigest ||
      pull.request.resultSchemaDigest !== claims.resultSchemaDigest
    )
      return { status: "rejected", code: "invalid_resolution_capability" };
    if (
      pull.resolution.revoked ||
      (claims.attemptId !== "none" && (!attempt || attempt.status === "revoked"))
    )
      return { status: "rejected", code: "capability_revoked" };
    if (task.lifecycle.status !== "active") return { status: "rejected", code: "task_terminal" };
    return undefined;
  };
  const early = reject();
  if (early) return early;
  let outcome = snapshotOutcome(request.outcome);
  if (outcome.status === "cancelled" && outcome.partial !== undefined) {
    const definition =
      pull.request.proposedDescriptor.kind === "effect"
        ? task.program.manifest.effects[pull.request.proposedDescriptor.name]
        : undefined;
    let partial: Json | undefined;
    let reason: "schema_validation_failed" | "payload_too_large" | "schema_version_unavailable" =
      "schema_validation_failed";
    if (definition?.cancellation) {
      const validated = parseRegisteredSchema(
        draft.context.schemas,
        definition.cancellation.partialSchema.digest,
        outcome.partial,
      );
      if (validated.status === "ok") {
        try {
          assertInlineSize(
            validated.value,
            Math.min(claims.maxOutcomeBytes, pull.request.maxOutcomeBytes),
          );
          partial = validated.value;
        } catch {
          reason = "payload_too_large";
        }
      } else if (validated.status === "unavailable") reason = "schema_version_unavailable";
    }
    if (partial === undefined) {
      draft.append(claims.sessionId, undefined, {
        type: "CancellationPartialDiscarded",
        taskId: task.taskId,
        pullId: pull.pullId,
        reason,
      });
      outcome = { status: "cancelled" };
    } else outcome = { status: "cancelled", partial };
  } else if (outcome.status === "ok") {
    if (pull.request.proposedDescriptor.kind === "elicit") {
      const envelope = parseProgramElicitResult(outcome.value);
      if (!envelope) return { status: "rejected", code: "schema_validation_failed" };
      if (envelope.action === "accept") {
        const validated = parseRegisteredSchema(
          draft.context.schemas,
          pull.request.resultSchemaDigest,
          envelope.content,
        );
        if (validated.status === "unavailable")
          return { status: "rejected", code: "schema_version_unavailable" };
        if (validated.status !== "ok")
          return { status: "rejected", code: "schema_validation_failed" };
        outcome = { status: "ok", value: { action: "accept", content: validated.value } };
      } else {
        const reason = sanitizeCancellationReason(
          typeof envelope.reason === "string" ? envelope.reason : undefined,
        );
        outcome = {
          status: "ok",
          value: { action: envelope.action, ...(reason === undefined ? {} : { reason }) },
        };
      }
    } else {
      const validated = parseRegisteredSchema(
        draft.context.schemas,
        pull.request.resultSchemaDigest,
        outcome.value,
      );
      if (validated.status === "unavailable")
        return { status: "rejected", code: "schema_version_unavailable" };
      if (validated.status !== "ok")
        return { status: "rejected", code: "schema_validation_failed" };
      outcome = { status: "ok", value: validated.value };
    }
  }
  try {
    assertInlineSize(outcome, Math.min(claims.maxOutcomeBytes, pull.request.maxOutcomeBytes));
  } catch {
    return { status: "rejected", code: "payload_too_large" };
  }
  if (
    pull.request.acceptedDescriptor.kind === "wait" &&
    outcome.status === "ok" &&
    pull.request.acceptedDescriptor.notBefore &&
    draft.context.nowMs < Date.parse(pull.request.acceptedDescriptor.notBefore)
  )
    return { status: "rejected", code: "wait_not_due" };
  const post = reject();
  if (post) return post;
  const digest = canonicalSnapshot(outcome).sha;
  if (pull.resolution.status === "settled") {
    if (pull.resolution.settlement.outcomeDigest === digest)
      return {
        status: "duplicate",
        receipt: { ...pull.resolution.settlement.receipt, status: "duplicate" },
      };
    return {
      status: "rejected",
      code: pull.attempts.length > 1 ? "idempotency_conflict" : "resolution_conflict",
    };
  }
  const offset = draft.append(claims.sessionId, undefined, {
    type: "PullResolved",
    taskId: task.taskId,
    pullId: pull.pullId,
    ...(attempt ? { attemptId: attempt.attemptId } : {}),
    outcome,
    outcomeDigest: digest,
  });
  if (attempt) {
    attempt.status = "completed";
    for (const competitor of pull.attempts) {
      if (
        competitor === attempt ||
        competitor.status === "revoked" ||
        competitor.status === "superseded"
      )
        continue;
      competitor.status = "superseded";
      draft.append(claims.sessionId, undefined, {
        type: "AttemptSuperseded",
        taskId: task.taskId,
        pullId: pull.pullId,
        attemptId: competitor.attemptId,
        winnerAttemptId: attempt.attemptId,
      });
    }
  }
  const receipt: ResolutionReceipt = {
    sessionId: taskOriginSession(draft.state, task.taskId),
    taskId: task.taskId,
    pullId: pull.pullId,
    resolutionOffset: offset,
    outcomeDigest: digest,
    status: "accepted",
  };
  pull.resolution = {
    status: "settled",
    revoked: pull.resolution.revoked,
    settlement: { outcome, outcomeDigest: digest, receipt },
  };
  task.nextActionIndex = Math.max(task.nextActionIndex, pullActionIndex(task, pull) + 1);
  if (
    task.lifecycle.status === "active" &&
    task.lifecycle.cancellation.type === "settling_pull" &&
    task.lifecycle.cancellation.pullId === pull.pullId
  )
    task.lifecycle.cancellation = {
      type: "requested",
      commandId: task.lifecycle.cancellation.commandId,
      ...(task.lifecycle.cancellation.reason === undefined
        ? {}
        : { reason: task.lifecycle.cancellation.reason }),
      frontier: task.lifecycle.cancellation.frontier,
    };
  draft.session(claims.sessionId).control.runnable = true;
  return { status: "accepted", receipt };
}

function appendEmission(draft: DecisionDraft, request: AppendEmissionRequest): EmissionReceipt {
  const task = draft.task(request.sessionId, request.taskId);
  draft.assertProgram(request.programCapability, task, request.sessionId);
  draft.assertActive(task);
  if (!task.program.manifest.capabilities.durableEmissions)
    throw new CrankError("invalid_descriptor", "Program does not declare durable emissions");
  const descriptor = canonicalSnapshot(request.descriptor).value;
  const digest = canonicalSnapshot(descriptor).sha;
  const existing = emissionByAction(task, request.actionIndex);
  if (existing) {
    if (existing.descriptorDigest !== digest)
      throw new CrankError("nondeterminism_detected", "Emission payload differs");
    return { ...existing.receipt, duplicate: true };
  }
  if (request.actionIndex !== task.nextActionIndex)
    throw new CrankError("nondeterminism_detected", "Emission action cursor mismatch");
  assertInlineSize(descriptor.payload, draft.maxOutcomeBytes);
  const payloadBytes = canonicalByteLength(descriptor.payload);
  const count = task.acceptedEmissionCount + 1;
  const total = task.cumulativeEmissionBytes + payloadBytes;
  if (
    (task.emissionPolicy?.maxEmissionsPerTask !== undefined &&
      count > task.emissionPolicy.maxEmissionsPerTask) ||
    (task.emissionPolicy?.maxCumulativeEmissionBytes !== undefined &&
      total > task.emissionPolicy.maxCumulativeEmissionBytes)
  )
    throw new CrankError("emission_quota_exceeded");
  if (request.restoredFrontier !== undefined) {
    consumeRestoredFrontier(
      draft,
      request.sessionId,
      task,
      request.restoredFrontier,
      request.restoredFrontierStep,
    );
  }
  const emissionIndex = task.nextEmissionIndex;
  const offset = draft.append(request.sessionId, task.execution.epoch, {
    type: "DurableEmission",
    taskId: task.taskId,
    actionIndex: request.actionIndex,
    emissionIndex,
    descriptor,
    descriptorDigest: digest,
  });
  const receipt: EmissionReceipt = {
    offset,
    eventId: `journal:${request.sessionId}:${offset}`,
    duplicate: false,
    ...(request.restoredFrontier === undefined ? {} : { restoredFrontierConsumed: true as const }),
  };
  task.actions.push({
    kind: "emission",
    actionIndex: request.actionIndex,
    emissionIndex,
    descriptorDigest: digest,
    receipt,
  });
  task.nextEmissionIndex += 1;
  task.nextActionIndex += 1;
  task.acceptedEmissionCount = count;
  task.cumulativeEmissionBytes = total;
  return receipt;
}

function completeTask(draft: DecisionDraft, request: CompleteTaskRequest): CompleteTaskResult {
  const task = draft.task(request.sessionId, request.taskId);
  draft.assertProgram(request.programCapability, task, request.sessionId);
  const proposed = snapshotOutcome(request.outcome);
  let outcome: OperationOutcome =
    task.lifecycle.status === "active" && task.lifecycle.cancellation.type === "unwinding"
      ? { status: "cancelled" }
      : proposed;
  if (outcome.status === "ok") {
    // Program-authored values may be refused by policy; refusals are data,
    // not exceptions (mirrors resolve-pull / validate-elicit-response).
    let value: Json;
    try {
      value = draft.parseSchema(
        task.program.manifest.outputSchema.digest,
        outcome.value,
        "schema_validation_failed",
      );
    } catch (error) {
      if (!(error instanceof CrankError) || error.code !== "schema_validation_failed") throw error;
      return { status: "rejected", code: error.code, message: error.message };
    }
    outcome = { status: "ok", value };
    try {
      assertInlineSize(outcome, draft.maxOutcomeBytes);
    } catch (error) {
      if (!(error instanceof CrankError) || error.code !== "payload_too_large") throw error;
      return { status: "rejected", code: error.code, message: error.message };
    }
  }
  assertInlineSize(outcome, draft.maxOutcomeBytes);
  const digest = canonicalSnapshot(outcome).sha;
  if (task.lifecycle.status === "closed" || task.lifecycle.status === "cancelled") {
    const receipt = task.lifecycle.receipt;
    const oldDigest = terminalOutcomeDigest(task.lifecycle.outcome);
    if (oldDigest !== digest)
      throw new CrankError("nondeterminism_detected", "Task completion differs");
    settleParentFromChild(draft, request.sessionId, task, outcome);
    return { status: "duplicate", receipt: { ...receipt, duplicate: true } };
  }
  draft.assertActive(task);
  if (request.actionIndex !== task.nextActionIndex) throw new CrankError("history_not_exhausted");
  if (
    task.actions.some(
      (action) => action.kind === "pull" && action.pull.resolution.status === "open",
    )
  )
    throw new CrankError("history_not_exhausted", "Task has an unresolved pull");
  if (request.restoredFrontier !== undefined) {
    consumeRestoredFrontier(
      draft,
      request.sessionId,
      task,
      request.restoredFrontier,
      request.restoredFrontierStep,
    );
  }
  const offset = draft.append(request.sessionId, task.execution.epoch, {
    type: "TaskClosed",
    taskId: task.taskId,
    outcome,
  });
  const receipt: TaskCloseReceipt = {
    offset,
    duplicate: false,
    ...(request.restoredFrontier === undefined ? {} : { restoredFrontierConsumed: true as const }),
  };
  const activeLifecycle = task.lifecycle.status === "active" ? task.lifecycle : undefined;
  const commandId =
    activeLifecycle && activeLifecycle.cancellation.type !== "none"
      ? activeLifecycle.cancellation.commandId
      : stableTupleHash(["cancel-command", request.sessionId, request.taskId]);
  task.lifecycle =
    outcome.status === "cancelled"
      ? {
          status: "cancelled",
          outcome: outcome as Extract<OperationOutcome, { status: "cancelled" }>,
          receipt,
          commandId,
        }
      : { status: "closed", outcome, receipt };
  settleParentFromChild(draft, request.sessionId, task, outcome);
  return { status: "accepted", receipt };
}

function requestCancellation(
  draft: DecisionDraft,
  sessionId: string,
  taskId: string,
  reason?: string,
  commandId = stableTupleHash(["cancel-command", sessionId, taskId]),
): CancellationAcknowledgement {
  const task = draft.task(sessionId, taskId);
  if (task.lifecycle.status !== "active") throw new CrankError("task_terminal");
  const current = task.lifecycle.cancellation;
  if (current.type !== "none")
    return {
      accepted: true,
      duplicate: true,
      commandId: current.commandId,
      ...(current.reason === undefined ? {} : { reason: current.reason }),
      frontier: structuredClone(current.frontier),
    };
  const frontierPull = pullByAction(task, task.nextActionIndex);
  const frontier = {
    actionIndex: task.nextActionIndex,
    ...(frontierPull === undefined ? {} : { pullId: frontierPull.pullId }),
  };
  const safeReason = sanitizeCancellationReason(reason);
  task.lifecycle.cancellation = {
    type: "requested",
    commandId,
    ...(safeReason === undefined ? {} : { reason: safeReason }),
    frontier,
  };
  draft.append(sessionId, undefined, {
    type: "CancellationRequested",
    taskId,
    commandId,
    ...(safeReason === undefined ? {} : { reason: safeReason }),
    frontier,
  });
  draft.session(sessionId).control.runnable = true;
  if (frontierPull && frontierPull.resolution.status === "open") {
    const child =
      frontierPull.request.acceptedDescriptor.kind === "invoke"
        ? [...draft.session(sessionId).execution.tasks.values()].find(
            (candidate) =>
              candidate.origin.kind === "child" &&
              candidate.origin.invokedBy.taskId === taskId &&
              candidate.origin.invokedBy.pullId === frontierPull.pullId &&
              candidate.lifecycle.status === "active",
          )
        : undefined;
    if (child) {
      task.lifecycle.cancellation = {
        type: "cancelling_children",
        commandId,
        childTaskIds: [child.taskId],
        ...(safeReason === undefined ? {} : { reason: safeReason }),
        frontier,
      };
      requestCancellation(
        draft,
        sessionId,
        child.taskId,
        safeReason,
        `${commandId}:child:${child.taskId}`,
      );
    } else {
      const live =
        draft.context.liveEffectTargets?.some(
          (target) => target.taskId === task.taskId && target.pullId === frontierPull.pullId,
        ) ?? false;
      if (live) {
        task.lifecycle.cancellation = {
          type: "settling_pull",
          commandId,
          pullId: frontierPull.pullId,
          ...(safeReason === undefined ? {} : { reason: safeReason }),
          frontier,
        };
      } else {
        cancelNonSettleablePull(draft, sessionId, task, frontierPull);
      }
    }
  }
  return {
    accepted: true,
    duplicate: false,
    commandId,
    ...(safeReason === undefined ? {} : { reason: safeReason }),
    frontier,
  };
}

function beginCancellationUnwind(
  draft: DecisionDraft,
  request: {
    sessionId: string;
    taskId: string;
    restoredFrontier?: { proof: RestoredFrontierProof; step: ProgramStep };
  },
): DurableCancellationState {
  const task = draft.task(request.sessionId, request.taskId);
  if (task.lifecycle.status !== "active") return terminalCancellation(task);
  const current = task.lifecycle.cancellation;
  if (current.type === "unwinding") return structuredClone(current);
  if (
    current.type !== "requested" &&
    current.type !== "settling_pull" &&
    current.type !== "cancelling_children"
  )
    throw new CrankError("invalid_command", "Task has no cancellation to unwind");
  const frontierPull = current.frontier.pullId
    ? pullById(task, current.frontier.pullId)
    : undefined;
  if (frontierPull && frontierPull.resolution.status === "open")
    throw new CrankError("cancellation_blocked");
  task.lifecycle.cancellation = {
    type: "unwinding",
    commandId: current.commandId,
    ...(current.reason === undefined ? {} : { reason: current.reason }),
    frontier: current.frontier,
  };
  return structuredClone(task.lifecycle.cancellation);
}

function detachAttempt(
  draft: DecisionDraft,
  request: { sessionId: string; taskId: string; pullId: string; reason?: string },
): void {
  const task = draft.task(request.sessionId, request.taskId);
  const pull = pullById(task, request.pullId);
  detachPullAttempts(draft, request.sessionId, task, pull, request.reason ?? "transport_lost");
}

function abandonAttempt(
  draft: DecisionDraft,
  request: {
    sessionId: string;
    taskId: string;
    pullId: string;
    attemptId: string;
    reason?: string;
  },
): void {
  const task = draft.task(request.sessionId, request.taskId);
  const pull = pullById(task, request.pullId);
  const attempt = pull.attempts.find((candidate) => candidate.attemptId === request.attemptId);
  if (!attempt) throw new CrankError("pull_not_found");
  if (attempt.status === "revoked") return;
  if (attempt.status === "completed" || attempt.status === "superseded")
    throw new CrankError("task_terminal");
  attempt.status = "revoked";
  draft.append(request.sessionId, undefined, {
    type: "AttemptAbandoned",
    taskId: request.taskId,
    pullId: request.pullId,
    attemptId: request.attemptId,
    reason: request.reason ?? "revoked",
  });
}

function forceOrphan(
  draft: DecisionDraft,
  request: {
    sessionId: string;
    taskId: string;
    reason:
      | "program_version_unavailable"
      | "program_corrupt"
      | "cleanup_stuck"
      | "replay_execution_failed"
      | "replay_diverged";
  },
): void {
  const task = draft.task(request.sessionId, request.taskId);
  if (task.lifecycle.status === "orphaned") return;
  draft.assertActive(task);
  for (const action of task.actions) {
    if (action.kind !== "pull" || action.pull.resolution.status === "settled") continue;
    action.pull.resolution = {
      ...action.pull.resolution,
      revoked: true,
    } as DraftPull["resolution"];
    for (const attempt of action.pull.attempts) {
      if (attempt.status === "started" || attempt.status === "detached") {
        attempt.status = "revoked";
        draft.append(request.sessionId, undefined, {
          type: "AttemptOutcomeUnknown",
          taskId: request.taskId,
          pullId: action.pull.pullId,
          attemptId: attempt.attemptId,
          reason: "force_orphaned",
        });
      }
    }
  }
  draft.append(request.sessionId, undefined, {
    type: "CleanupSkipped",
    taskId: request.taskId,
    reason: request.reason,
  });
  draft.append(request.sessionId, undefined, {
    type: "TaskOrphaned",
    taskId: request.taskId,
    reason: request.reason,
  });
  task.lifecycle = { status: "orphaned", reason: request.reason };
}

function claimActivation(
  draft: DecisionDraft,
  request: ClaimActivationRequest,
): ClaimActivationResult {
  if (!request.sessionId || !request.ownerId) throw new CrankError("invalid_command");
  const duration = request.leaseDurationMs ?? 30_000;
  if (!Number.isInteger(duration) || duration < 1_000 || duration > 300_000)
    throw new CrankError("invalid_command");
  const session = draft.session(request.sessionId);
  const now = draft.context.nowMs;
  const notBefore = session.control.activationNotBeforeMs ?? 0;
  if (now < notBefore) return { status: "busy", retryAfterMs: notBefore - now };
  const current = session.control.activationLease;
  if (current && now < current.expiresAtMs)
    return { status: "busy", retryAfterMs: current.expiresAtMs - now };
  const expiredTakeover = current !== undefined;
  if (!session.control.runnable && !expiredTakeover) return { status: "not_runnable" };
  const epoch = session.control.lastActivationEpoch + 1;
  session.control.lastActivationEpoch = epoch;
  for (const task of session.execution.tasks.values())
    if (task.lifecycle.status === "active") task.execution.epoch = epoch;
  const restoreNonce = draft.nonce();
  session.control.restoreNonce = restoreNonce;
  const lease: ActivationLeaseState = {
    sessionId: request.sessionId,
    ownerId: request.ownerId,
    epoch,
    expiresAtMs: now + duration,
    leaseDurationMs: duration,
    claimedTaskRevision: session.control.revision,
    claimedHeadDigest: draft.context.journalHeadDigest,
    restoreNonce,
  };
  session.control.activationLease = lease;
  session.control.runnable = false;
  return {
    status: "claimed",
    epoch,
    expiresAtMs: lease.expiresAtMs,
    taskRevision: session.control.revision,
    journalHeadDigest: draft.context.journalHeadDigest,
  };
}

function renewActivation(
  draft: DecisionDraft,
  request: RenewActivationRequest,
): RenewActivationResult {
  const session = draft.session(request.sessionId);
  const lease = session.control.activationLease;
  if (
    !lease ||
    lease.ownerId !== request.ownerId ||
    lease.epoch !== request.epoch ||
    draft.context.nowMs >= lease.expiresAtMs
  )
    return { status: "stale_activation" };
  const expiresAtMs = draft.context.nowMs + lease.leaseDurationMs;
  session.control.activationLease = { ...lease, expiresAtMs };
  return { status: "renewed", expiresAtMs };
}

function releaseActivation(
  draft: DecisionDraft,
  request: ReleaseActivationRequest,
): ReleaseActivationResult {
  const session = draft.session(request.sessionId);
  const lease = session.control.activationLease;
  if (!lease || lease.ownerId !== request.ownerId || lease.epoch !== request.epoch)
    return { status: "stale_activation" };
  delete session.control.activationLease;
  const retryable = ["failed", "scope_exit", "lease_lost"].includes(request.reason);
  const runnable = request.reason !== "terminal" && (retryable || session.control.runnable);
  session.control.runnable = runnable;
  return { status: "released", runnable };
}

function issueRestoreTicket(
  draft: DecisionDraft,
  request: IssueRestoreTicketRequest,
): IssueRestoreTicketResult {
  const session = draft.session(request.sessionId);
  const lease = requireLease(draft, session, request.ownerId, request.activationEpoch);
  draft.task(request.sessionId, request.taskId);
  const restoreNonce = draft.nonce();
  session.control.restoreNonce = restoreNonce;
  session.control.activationLease = { ...lease, restoreNonce };
  const claims = restoreClaims(
    draft,
    request,
    session,
    restoreNonce,
    -1,
    request.replayChainDigest,
  );
  return {
    restoreTicket: signPrivateAuthorityToken("restore-ticket", claims, draft.context.keyring),
    taskRevision: claims.taskRevision,
    journalHeadDigest: claims.journalHeadDigest,
  };
}

function prepareRestore(
  draft: DecisionDraft,
  request: PrepareProgramRestoreRequest,
): PreparedProgramRestore {
  const session = draft.session(request.sessionId);
  const lease = requireLease(draft, session, request.ownerId, request.activationEpoch);
  const task = draft.task(request.sessionId, request.taskId);
  if (task.execution.epoch !== request.activationEpoch) throw new CrankError("stale_activation");
  const restoreNonce = draft.nonce();
  const replayChainSeed = sha256(
    canonicalJson({
      domain: request.replayDomain,
      protocolVersion: 1,
      releaseId: request.releaseId,
      sessionId: request.sandboxSessionId,
      taskId: request.taskId,
      program: task.program.artifact,
      activationEpoch: request.activationEpoch,
      journalHeadDigest: draft.context.journalHeadDigest,
      restoreNonce,
    }),
  );
  const replay: ReplayEntry[] = [];
  let previousEntryDigest = replayChainSeed;
  let replayedThroughActionIndex = -1;
  for (let actionIndex = 0; actionIndex < task.nextActionIndex; actionIndex += 1) {
    const action = task.actions.find((candidate) => candidate.actionIndex === actionIndex);
    if (!action) throw new CrankError("invalid_journal", "Replay history has an action gap");
    let body: Omit<ReplayOperationEntry, "entryDigest"> | Omit<ReplayEmissionEntry, "entryDigest">;
    if (action.kind === "pull" && action.pull.resolution.status === "settled")
      body = {
        type: "operation",
        actionIndex,
        descriptorKind: action.pull.request.proposedDescriptor.kind,
        descriptorDigest: action.pull.request.proposedDescriptorDigest,
        previousEntryDigest,
        outcome: structuredClone(action.pull.resolution.settlement.outcome),
        receipt: structuredClone(action.pull.resolution.settlement.receipt),
      };
    else if (action.kind === "emission")
      body = {
        type: "emission",
        actionIndex,
        descriptorKind: "emission",
        descriptorDigest: action.descriptorDigest,
        previousEntryDigest,
        offset: action.receipt.offset,
      };
    else throw new CrankError("invalid_journal", "Replay history has an action gap");
    const entryDigest = sha256(
      canonicalJson({ replayChainSeed, previousEntryDigest, entryWithoutEntryDigest: body }),
    );
    replay.push({ ...body, entryDigest } as ReplayEntry);
    previousEntryDigest = entryDigest;
    replayedThroughActionIndex = actionIndex;
  }
  session.control.restoreNonce = restoreNonce;
  Reflect.deleteProperty(session.control, "restoreFrontierDigest");
  session.control.activationLease = { ...lease, restoreNonce };
  const claims = restoreClaims(
    draft,
    request,
    session,
    restoreNonce,
    replayedThroughActionIndex,
    previousEntryDigest,
  );
  return {
    restoreTicket: signPrivateAuthorityToken("restore-ticket", claims, draft.context.keyring),
    replay,
    replayedThroughActionIndex,
    replayChainSeed,
    replayChainDigest: previousEntryDigest,
    taskRevision: claims.taskRevision,
    journalHeadDigest: claims.journalHeadDigest,
  };
}

function bindFrontier(
  draft: DecisionDraft,
  request: BindRestoreFrontierRequest,
): BindRestoreFrontierResult {
  let claims;
  try {
    claims = parseRestoreTicketClaims(
      verifyPrivateAuthorityToken(request.restoreTicket, "restore-ticket", draft.context.keyring),
    );
  } catch {
    return { status: "restore_stale" };
  }
  const session = draft.session(request.sessionId);
  const lease = session.control.activationLease;
  if (
    !/^[0-9a-f]{64}$/.test(request.frontierDigest) ||
    !lease ||
    draft.context.nowMs >= lease.expiresAtMs ||
    lease.ownerId !== request.ownerId ||
    lease.epoch !== request.activationEpoch ||
    claims.sessionId !== request.sessionId ||
    claims.taskId !== request.taskId ||
    claims.ownerId !== request.ownerId ||
    claims.activationEpoch !== request.activationEpoch ||
    claims.taskRevision !== session.control.revision ||
    claims.journalHeadDigest !== draft.context.journalHeadDigest ||
    claims.restoreNonce !== session.control.restoreNonce
  )
    return { status: "restore_stale" };
  session.control.restoreFrontierDigest = request.frontierDigest;
  return {
    status: "bound",
    proof: { restoreTicket: request.restoreTicket, frontierDigest: request.frontierDigest },
  };
}

function consumeTicket(
  draft: DecisionDraft,
  request: ConsumeRestoreTicketRequest,
): ConsumeRestoreTicketResult {
  let claims;
  try {
    claims = parseRestoreTicketClaims(
      verifyPrivateAuthorityToken(
        request.proof.restoreTicket,
        "restore-ticket",
        draft.context.keyring,
      ),
    );
  } catch {
    return recordRestoreStale(draft, request.sessionId);
  }
  const session = draft.session(request.sessionId);
  const lease = session.control.activationLease;
  const valid =
    /^[0-9a-f]{64}$/.test(request.proof.frontierDigest) &&
    claims.journalId === draft.context.journalIdentity.id &&
    claims.journalIncarnation === draft.context.journalIdentity.incarnation &&
    claims.sessionId === request.sessionId &&
    claims.taskId === request.taskId &&
    claims.ownerId === request.ownerId &&
    claims.activationEpoch === request.activationEpoch &&
    lease?.ownerId === request.ownerId &&
    lease.epoch === request.activationEpoch &&
    draft.context.nowMs < lease.expiresAtMs &&
    claims.taskRevision === session.control.revision &&
    claims.journalHeadDigest === draft.context.journalHeadDigest &&
    claims.restoreNonce === session.control.restoreNonce &&
    request.proof.frontierDigest === session.control.restoreFrontierDigest;
  if (!valid) return recordRestoreStale(draft, request.sessionId);
  const nonce = draft.nonce();
  session.control.restoreNonce = nonce;
  Reflect.deleteProperty(session.control, "restoreFrontierDigest");
  session.control.activationLease = { ...lease!, restoreNonce: nonce };
  session.control.consecutiveRestoreStales = 0;
  Reflect.deleteProperty(session.control, "activationNotBeforeMs");
  return { status: "consumed" };
}

function validateElicitResponse(
  state: AuthorityState,
  context: AuthorityDecisionFrame<AuthorityCommand>["context"],
  request: ValidateElicitResponseRequest,
): ValidateElicitResponseResult {
  const found = findPullById(state, request.pullId);
  if (!found) return { status: "not_pending" };
  const [sessionId, task, pull] = found;
  if (
    sessionId !== request.sessionId ||
    task.lifecycle.status !== "active" ||
    pull.request.proposedDescriptor.kind !== "elicit" ||
    pull.resolution.status !== "open" ||
    pull.resolution.revoked
  )
    return { status: "not_pending" };
  if (request.participantId !== pullAudience(pull)) return { status: "audience_invalid" };
  const descriptorContext = pull.request.proposedDescriptor.context;
  if (
    descriptorContext !== null &&
    typeof descriptorContext === "object" &&
    !Array.isArray(descriptorContext)
  ) {
    const expiresAt = descriptorContext["expiresAt"];
    if (
      typeof expiresAt === "string" &&
      Number.isFinite(Date.parse(expiresAt)) &&
      context.nowMs >= Date.parse(expiresAt)
    )
      return { status: "expired" };
  }
  const envelope = parseProgramElicitResult(request.completion);
  if (!envelope) return { status: "schema_validation_failed" };
  let value: Json;
  if (envelope.action === "accept") {
    const validated = parseRegisteredSchema(
      context.schemas,
      pull.request.resultSchemaDigest,
      envelope.content,
    );
    if (validated.status === "unavailable") return { status: "schema_version_unavailable" };
    if (validated.status !== "ok") return { status: "schema_validation_failed" };
    value = { action: "accept", content: validated.value };
  } else {
    const reason = sanitizeCancellationReason(
      typeof envelope.reason === "string" ? envelope.reason : undefined,
    );
    value = { action: envelope.action, ...(reason === undefined ? {} : { reason }) };
  }
  try {
    assertInlineSize({ status: "ok", value }, pull.request.maxOutcomeBytes);
  } catch {
    return { status: "schema_validation_failed" };
  }
  return {
    status: "valid",
    taskId: task.taskId,
    audience: pullAudience(pull),
    outcome: { status: "ok", value },
  };
}

function assertNever(value: never): never {
  throw new CrankError(
    "invalid_command",
    `Unknown authority operation ${(value as { type?: string }).type ?? "missing"}`,
  );
}

function cloneState(state: AuthorityState): DraftState {
  return structuredClone(state) as unknown as DraftState;
}

function taskOriginSession(state: AuthorityState, taskId: string): string {
  for (const [sessionId, session] of state.sessions)
    if (session.execution.tasks.has(taskId)) return sessionId;
  throw new CrankError("unknown_target", `Unknown task ${taskId}`);
}

function taskFor(state: AuthorityState, sessionId: string, taskId: string): TaskState {
  const task = state.sessions.get(sessionId)?.execution.tasks.get(taskId);
  if (!task) throw new CrankError("unknown_target", `Unknown task ${taskId}`);
  return task;
}

function pullByAction(task: TaskState, actionIndex: number): DraftPull | undefined {
  const action = task.actions.find(
    (candidate) => candidate.kind === "pull" && candidate.actionIndex === actionIndex,
  );
  return action?.kind === "pull" ? (action.pull as DraftPull) : undefined;
}

function pullById(task: TaskState, pullId: string): DraftPull {
  const action = task.actions.find(
    (candidate) => candidate.kind === "pull" && candidate.pull.pullId === pullId,
  );
  if (!action || action.kind !== "pull") throw new CrankError("pull_not_found");
  return action.pull as DraftPull;
}

function pullActionIndex(task: TaskState, pull: PullState): number {
  return (
    task.actions.find(
      (candidate) => candidate.kind === "pull" && candidate.pull.pullId === pull.pullId,
    )?.actionIndex ?? -1
  );
}

function emissionByAction(
  task: TaskState,
  actionIndex: number,
): Extract<ActionState, { kind: "emission" }> | undefined {
  const action = task.actions.find(
    (candidate) => candidate.kind === "emission" && candidate.actionIndex === actionIndex,
  );
  return action?.kind === "emission" ? action : undefined;
}

function currentAttempt(pull: PullState) {
  return [...pull.attempts]
    .filter((attempt) => attempt.status === "started")
    .sort((left, right) => right.attemptIndex - left.attemptIndex)[0];
}
function pullAudience(pull: PullState): string {
  return pull.resolutionAuthority.audience;
}
function executableDescriptor(descriptor: DurableOperationDescriptor): boolean {
  return descriptor.kind === "effect" || descriptor.kind === "record";
}
function pendingResolutionAuthority(
  descriptor: DurableOperationDescriptor,
  audience: string,
): ResolutionAuthority {
  const policy = pullKindPolicy(descriptor.kind);
  if (!policy?.resolutionAuthority) {
    throw new CrankError("invalid_descriptor");
  }
  return policy.resolutionAuthority(descriptor, audience);
}

function startAttempt(
  draft: DecisionDraft,
  task: DraftTask,
  pull: DraftPull,
): Extract<ReserveOperationResult, { status: "authorized" }> {
  const attemptIndex = pull.attempts.length;
  const attemptId = `${pull.pullId}:attempt-${attemptIndex}`;
  const capability = draft.resolutionCapability(task, pull, attemptId);
  pull.attempts.push({ attemptId, attemptIndex, capability, status: "started" });
  draft.append(taskOriginSession(draft.state, task.taskId), task.execution.epoch, {
    type: "AttemptStarted",
    taskId: task.taskId,
    pullId: pull.pullId,
    attemptId,
    attemptIndex,
  });
  const descriptor = installedOrRecordedDescriptor(pull.request.acceptedDescriptor);
  pull.resolutionAuthority = {
    kind: "attempt",
    owner: descriptor.kind === "record" ? "program" : "effect",
    audience: pullAudience(pull),
  };
  return {
    status: "authorized",
    pullId: pull.pullId,
    attemptId,
    descriptor,
    ...(descriptor.kind === "effect"
      ? {
          effectContractDigest: effectDigestForPull(task.program.manifest, descriptor),
          effectDefinition: structuredClone(task.program.manifest.effects[descriptor.name]!),
        }
      : {}),
    resolutionCapability: capability,
  };
}

function authorizeExisting(
  draft: DecisionDraft,
  task: DraftTask,
  pull: DraftPull,
): Extract<ReserveOperationResult, { status: "authorized" }> {
  const active = currentAttempt(pull);
  return active
    ? {
        status: "authorized",
        pullId: pull.pullId,
        attemptId: active.attemptId,
        descriptor: installedOrRecordedDescriptor(pull.request.acceptedDescriptor),
        ...(pull.request.acceptedDescriptor.kind === "effect"
          ? {
              effectContractDigest: effectDigestForPull(
                task.program.manifest,
                pull.request.acceptedDescriptor,
              ),
              effectDefinition: structuredClone(
                task.program.manifest.effects[pull.request.acceptedDescriptor.name]!,
              ),
            }
          : {}),
        resolutionCapability: active.capability,
      }
    : startAttempt(draft, task, pull);
}

function findTaskPullById(
  state: AuthorityState,
  taskId: string,
  pullId: string,
): [string, DraftTask, DraftPull] | undefined {
  for (const [sessionId, session] of state.sessions) {
    const task = session.execution.tasks.get(taskId);
    if (!task) continue;
    const action = task.actions.find(
      (candidate) => candidate.kind === "pull" && candidate.pull.pullId === pullId,
    );
    if (action?.kind === "pull") return [sessionId, task as DraftTask, action.pull as DraftPull];
  }
  return undefined;
}
function findPullById(
  state: AuthorityState,
  pullId: string,
): [string, DraftTask, DraftPull] | undefined {
  for (const [sessionId, session] of state.sessions)
    for (const task of session.execution.tasks.values())
      for (const action of task.actions)
        if (action.kind === "pull" && action.pull.pullId === pullId)
          return [sessionId, task as DraftTask, action.pull as DraftPull];
  return undefined;
}

function settleParentFromChild(
  draft: DecisionDraft,
  sessionId: string,
  task: DraftTask,
  outcome: OperationOutcome,
): void {
  if (task.origin.kind !== "child") return;
  const parent = draft.task(sessionId, task.origin.invokedBy.taskId);
  const pull = pullById(parent, task.origin.invokedBy.pullId);
  if (!["invoke", "all", "race", "spawn", "join"].includes(pull.request.acceptedDescriptor.kind))
    throw new CrankError("invalid_journal");
  const group = parent.forkGroup;
  if (group !== undefined && group.pullId === pull.pullId) {
    settleForkGroupMember(draft, sessionId, parent, pull, group, task, outcome);
    return;
  }
  settlePullWithOutcome(draft, sessionId, parent, pull, task.execution.epoch, outcome);
}

function settlePullWithOutcome(
  draft: DecisionDraft,
  sessionId: string,
  parent: DraftTask,
  pull: DraftPull,
  ownerEpoch: number,
  outcome: OperationOutcome,
): void {
  const digest = canonicalSnapshot(outcome).sha;
  if (pull.resolution.status === "settled") {
    if (pull.resolution.settlement.outcomeDigest !== digest)
      throw new CrankError("nondeterminism_detected");
    return;
  }
  const offset = draft.append(sessionId, ownerEpoch, {
    type: "PullResolved",
    taskId: parent.taskId,
    pullId: pull.pullId,
    outcome: structuredClone(outcome),
    outcomeDigest: digest,
  });
  pull.resolution = {
    status: "settled",
    revoked: pull.resolution.revoked,
    settlement: {
      outcome: structuredClone(outcome),
      outcomeDigest: digest,
      receipt: {
        sessionId,
        taskId: parent.taskId,
        pullId: pull.pullId,
        resolutionOffset: offset,
        outcomeDigest: digest,
        status: "accepted",
      },
    },
  };
  parent.nextActionIndex = Math.max(parent.nextActionIndex, pullActionIndex(parent, pull) + 1);
  draft.session(sessionId).control.runnable = true;
}

/**
 * Folds a member terminal into the fork-group algebra (REQ-026). The parent
 * fork slot resolves exactly once, to the closed Terminal value; member
 * biographies cross only inside it. Winner selection, policy-driven member
 * cancellation, and resolution evidence are journal records, in commit
 * order (REQ-032).
 */
function settleForkGroupMember(
  draft: DecisionDraft,
  sessionId: string,
  parent: DraftTask,
  pull: DraftPull,
  group: DeepMutable<ForkGroupState>,
  member: DraftTask,
  outcome: OperationOutcome,
): void {
  const reduction = reduceForkMemberTerminal(group, member.taskId, outcome);
  if (reduction.winnerSelected !== undefined) {
    const lifecycle = member.lifecycle;
    const closeOffset =
      lifecycle.status === "closed" || lifecycle.status === "cancelled"
        ? lifecycle.receipt.offset
        : "0";
    draft.append(sessionId, member.execution.epoch, {
      type: "RaceWinnerSelected",
      taskId: parent.taskId,
      pullId: pull.pullId,
      winnerTaskId: member.taskId,
      closeOffset,
      outcomeDigest: reduction.winnerSelected.outcomeDigest,
    });
  }
  for (const memberTaskId of reduction.cancelMembers) {
    requestCancellation(draft, sessionId, memberTaskId, "fork_group_cancelled");
  }
  if (reduction.resolution !== undefined) {
    const terminal = reduction.resolution;
    draft.append(sessionId, parent.execution.epoch, {
      type: "ForkGroupResolved",
      taskId: parent.taskId,
      pullId: pull.pullId,
      groupId: group.groupId,
      terminal,
      terminalDigest: canonicalSnapshot(terminal).sha,
    });
    settlePullWithOutcome(
      draft,
      sessionId,
      parent,
      pull,
      parent.execution.epoch,
      forkGroupOutcome(terminal),
    );
  }
}

function cancelNonSettleablePull(
  draft: DecisionDraft,
  sessionId: string,
  task: DraftTask,
  pull: DraftPull,
): void {
  pull.resolution = { status: "open", revoked: true };
  let uncertain: string | undefined;
  for (const attempt of pull.attempts) {
    if (attempt.status === "started" || attempt.status === "detached")
      uncertain ??= attempt.attemptId;
    if (attempt.status !== "completed" && attempt.status !== "superseded")
      attempt.status = "revoked";
  }
  if (uncertain)
    draft.append(sessionId, undefined, {
      type: "AttemptOutcomeUnknown",
      taskId: task.taskId,
      pullId: pull.pullId,
      attemptId: uncertain,
      reason: "no_settlement_path",
    });
  settlePull(draft, sessionId, task, pull, { status: "cancelled" });
}
function settlePull(
  draft: DecisionDraft,
  sessionId: string,
  task: DraftTask,
  pull: DraftPull,
  outcome: OperationOutcome,
): void {
  const digest = canonicalSnapshot(outcome).sha;
  const offset = draft.append(sessionId, undefined, {
    type: "PullResolved",
    taskId: task.taskId,
    pullId: pull.pullId,
    outcome,
    outcomeDigest: digest,
  });
  pull.resolution = {
    status: "settled",
    revoked: pull.resolution.revoked,
    settlement: {
      outcome,
      outcomeDigest: digest,
      receipt: {
        sessionId,
        taskId: task.taskId,
        pullId: pull.pullId,
        resolutionOffset: offset,
        outcomeDigest: digest,
        status: "accepted",
      },
    },
  };
  task.nextActionIndex = Math.max(task.nextActionIndex, pullActionIndex(task, pull) + 1);
}
function detachTaskAttempts(
  draft: DecisionDraft,
  sessionId: string,
  task: DraftTask,
  reason: string,
): void {
  for (const action of task.actions)
    if (action.kind === "pull")
      detachPullAttempts(draft, sessionId, task, action.pull as DraftPull, reason);
}
function detachPullAttempts(
  draft: DecisionDraft,
  sessionId: string,
  task: DraftTask,
  pull: DraftPull,
  reason: string,
): void {
  for (const attempt of pull.attempts)
    if (attempt.status === "started") {
      attempt.status = "detached";
      draft.append(sessionId, undefined, {
        type: "AttemptDetached",
        taskId: task.taskId,
        pullId: pull.pullId,
        attemptId: attempt.attemptId,
        reason,
      });
      const descriptor = pull.request.acceptedDescriptor;
      const retrySafety =
        descriptor.kind === "effect"
          ? task.program.manifest.effects[descriptor.name]?.retrySafety
          : descriptor.kind === "record"
            ? descriptor.retrySafety
            : undefined;
      if (
        (descriptor.kind === "effect" || descriptor.kind === "record") &&
        retrySafety?.mode === "unsafe"
      ) {
        draft.append(sessionId, undefined, {
          type: "PullIndeterminate",
          taskId: task.taskId,
          pullId: pull.pullId,
          attemptId: attempt.attemptId,
        });
        failIndeterminate(draft, sessionId, task, pull, attempt, reason);
      }
    }
}
function failIndeterminate(
  draft: DecisionDraft,
  sessionId: string,
  task: DraftTask,
  pull: DraftPull,
  attempt: DeepMutable<PullState["attempts"][number]>,
  reason: string,
): void {
  attempt.status = "revoked";
  draft.append(sessionId, undefined, {
    type: "AttemptAbandoned",
    taskId: task.taskId,
    pullId: pull.pullId,
    attemptId: attempt.attemptId,
    reason: "indeterminate_fail",
  });
  const outcome: OperationOutcome = {
    status: "error",
    error: {
      code: "effect_outcome_indeterminate",
      message: "Unsafe effect outcome became indeterminate",
      details: {
        pullId: pull.pullId,
        attemptId: attempt.attemptId,
        reason: sanitizeCancellationReason(reason) ?? "detached",
      },
    },
  };
  assertInlineSize(outcome, pull.request.maxOutcomeBytes);
  settlePull(draft, sessionId, task, pull, outcome);
  if (
    task.lifecycle.status === "active" &&
    task.lifecycle.cancellation.type === "settling_pull" &&
    task.lifecycle.cancellation.pullId === pull.pullId
  )
    task.lifecycle.cancellation = {
      type: "requested",
      commandId: task.lifecycle.cancellation.commandId,
      ...(task.lifecycle.cancellation.reason === undefined
        ? {}
        : { reason: task.lifecycle.cancellation.reason }),
      frontier: task.lifecycle.cancellation.frontier,
    };
  draft.session(sessionId).control.runnable = true;
}

function consumeRestoredFrontier(
  draft: DecisionDraft,
  sessionId: string,
  task: DraftTask,
  proof: RestoredFrontierProof,
  step: ProgramStep | undefined,
): void {
  const session = draft.session(sessionId);
  const lease = session.control.activationLease;
  if (!lease || step === undefined) throw new CrankError("restore_stale");
  let claims;
  try {
    claims = parseRestoreTicketClaims(
      verifyPrivateAuthorityToken(proof.restoreTicket, "restore-ticket", draft.context.keyring),
    );
  } catch {
    throw new CrankError("restore_stale");
  }
  if (!claims.releaseId || !claims.frontierDomain) throw new CrankError("restore_stale");
  const expected = sha256(
    canonicalJson({
      domain: claims.frontierDomain,
      protocolVersion: 1,
      releaseId: claims.releaseId,
      taskId: task.taskId,
      activationEpoch: task.execution.epoch,
      replayedThroughActionIndex: claims.replayedThroughActionIndex,
      replayChainDigest: claims.replayChainDigest,
      step,
    }),
  );
  if (proof.frontierDigest !== expected) throw new CrankError("restore_stale");
  const result = consumeTicket(draft, {
    sessionId,
    taskId: task.taskId,
    ownerId: lease.ownerId,
    activationEpoch: task.execution.epoch,
    proof,
  });
  if (result.status === "restore_stale") throw new CrankError("restore_stale");
}

function requireLease(
  draft: DecisionDraft,
  session: DraftSession,
  ownerId: string,
  epoch: number,
): ActivationLeaseState {
  const lease = session.control.activationLease;
  if (
    !lease ||
    lease.ownerId !== ownerId ||
    lease.epoch !== epoch ||
    draft.context.nowMs >= lease.expiresAtMs
  )
    throw new CrankError("stale_activation");
  return lease;
}
function restoreClaims(
  draft: DecisionDraft,
  request: {
    sessionId: string;
    taskId: string;
    ownerId: string;
    activationEpoch: number;
    releaseId?: string;
    sandboxSessionId?: string;
    replayDomain?: string;
    frontierDomain?: string;
    replayedThroughActionIndex?: number;
    replayChainDigest?: string;
  },
  session: DraftSession,
  restoreNonce: string,
  replayedThroughActionIndex: number,
  replayChainDigest: string,
) {
  return {
    version: 1 as const,
    journalId: draft.context.journalIdentity.id,
    journalIncarnation: draft.context.journalIdentity.incarnation,
    sessionId: request.sessionId,
    taskId: request.taskId,
    ownerId: request.ownerId,
    activationEpoch: request.activationEpoch,
    ...(request.releaseId === undefined ? {} : { releaseId: request.releaseId }),
    ...(request.sandboxSessionId === undefined
      ? {}
      : { sandboxSessionId: request.sandboxSessionId }),
    ...(request.replayDomain === undefined ? {} : { replayDomain: request.replayDomain }),
    ...(request.frontierDomain === undefined ? {} : { frontierDomain: request.frontierDomain }),
    taskRevision: session.control.revision,
    journalHeadDigest: draft.context.journalHeadDigest,
    replayedThroughActionIndex,
    replayChainDigest,
    restoreNonce,
  };
}
function recordRestoreStale(
  draft: DecisionDraft,
  sessionId: string,
): Extract<ConsumeRestoreTicketResult, { status: "restore_stale" }> {
  const session = draft.session(sessionId);
  Reflect.deleteProperty(session.control, "restoreFrontierDigest");
  const count = session.control.consecutiveRestoreStales + 1;
  session.control.consecutiveRestoreStales = count;
  if (count < 3)
    return {
      status: "restore_stale",
      consecutiveStales: count,
      retryAfterMs: 0,
      releaseRequired: false,
    };
  const retryAfterMs = Math.min(250 * 2 ** (count - 3), 5_000);
  session.control.activationNotBeforeMs = draft.context.nowMs + retryAfterMs;
  delete session.control.activationLease;
  session.control.runnable = true;
  return { status: "restore_stale", consecutiveStales: count, retryAfterMs, releaseRequired: true };
}

function terminalOutcome(task: TaskState): OperationOutcome | undefined {
  return task.lifecycle.status === "closed" || task.lifecycle.status === "cancelled"
    ? task.lifecycle.outcome
    : undefined;
}
function terminalCancellation(task: TaskState): DurableCancellationState {
  if (task.lifecycle.status === "cancelled")
    return { type: "cancelled", commandId: task.lifecycle.commandId };
  if (task.lifecycle.status === "orphaned")
    return { type: "orphaned", reason: task.lifecycle.reason };
  return { type: "none" };
}
function openElicitCount(state: AuthorityState, sessionId: string): number {
  let count = 0;
  const session = state.sessions.get(sessionId);
  if (!session) return 0;
  for (const task of session.execution.tasks.values())
    if (task.lifecycle.status === "active")
      for (const action of task.actions)
        if (
          action.kind === "pull" &&
          action.pull.request.proposedDescriptor.kind === "elicit" &&
          action.pull.resolution.status === "open" &&
          !action.pull.resolution.revoked
        )
          count++;
  return count;
}
function assertEffectContractsCompatible(
  state: AuthorityState,
  manifest: DurableProgramManifest,
): void {
  const retained = new Map<string, string>();
  for (const session of state.sessions.values()) {
    for (const task of session.execution.tasks.values()) {
      for (const definition of Object.values(task.program.manifest.effects)) {
        retained.set(
          stableTupleHash([definition.name, definition.version]),
          effectContractDigest(definition),
        );
      }
    }
  }
  for (const definition of Object.values(manifest.effects)) {
    const key = stableTupleHash([definition.name, definition.version]);
    const digest = effectContractDigest(definition);
    if (retained.has(key) && retained.get(key) !== digest) {
      throw new CrankError("invalid_manifest");
    }
  }
}

function nonterminalSchemaDigests(state: AuthorityState): string[] {
  const result = new Set<string>();
  for (const session of state.sessions.values())
    for (const task of session.execution.tasks.values())
      if (task.lifecycle.status === "active") {
        for (const digest of manifestSchemaDigests(task.program.manifest)) result.add(digest);
        for (const action of task.actions)
          if (action.kind === "pull" && action.pull.resolution.status === "open")
            result.add(action.pull.request.resultSchemaDigest);
      }
  return sortedStrings(result);
}
function recoverableSessions(state: AuthorityState, now: number): RecoverableSession[] {
  const result = new Map<string, RecoverableSession>();
  for (const [id, session] of state.sessions) {
    if (
      session.control.runnable &&
      (session.control.activationNotBeforeMs === undefined ||
        now >= session.control.activationNotBeforeMs)
    )
      result.set(id, { sessionId: id, reason: "runnable" });
    if (session.control.activationLease && now >= session.control.activationLease.expiresAtMs)
      result.set(id, { sessionId: id, reason: "expired_activation" });
  }
  return [...result.values()].sort((a, b) => a.sessionId.localeCompare(b.sessionId));
}
function rootTaskCount(state: AuthorityState, sessionId: string): number {
  const tasks = [...(state.sessions.get(sessionId)?.execution.tasks.values() ?? [])].filter(
    (task) => task.origin.kind === "root",
  );
  const ordinal = tasks.reduce((max, task) => {
    const match = /^turn-(\d+)(?:\/root)?$/.exec(task.taskId);
    return match ? Math.max(max, Number(match[1]) + 1) : max;
  }, 0);
  return Math.max(tasks.length, ordinal);
}
function taskExecutionState(
  state: AuthorityState,
  sessionId: string,
  taskId: string,
): DurableTaskExecutionState {
  const task = taskFor(state, sessionId, taskId);
  return {
    executionEpoch: task.execution.epoch,
    ...(task.execution.route === undefined ? {} : { route: structuredClone(task.execution.route) }),
    ...(task.execution.catalog === undefined
      ? {}
      : {
          catalog: structuredClone(task.execution.catalog),
          catalogDigest: task.execution.catalogDigest!,
        }),
  };
}
function operationState(
  state: AuthorityState,
  sessionId: string,
  taskId: string,
  pullId: string,
): DurableOperationState {
  const task = state.sessions.get(sessionId)?.execution.tasks.get(taskId);
  const pull = task
    ? [...task.actions].find((action) => action.kind === "pull" && action.pull.pullId === pullId)
    : undefined;
  if (!pull || pull.kind !== "pull") return { status: "not_found" };
  return {
    status: "found",
    descriptor: structuredClone(pull.pull.request.proposedDescriptor),
    audience: pullAudience(pull.pull),
    ...(pull.pull.resolution.status === "settled"
      ? { outcome: structuredClone(pull.pull.resolution.settlement.outcome) }
      : {}),
  };
}
function taskRecoveryState(
  state: AuthorityState,
  sessionId: string,
  requestedTaskId?: string,
): DurableTaskRecoveryState {
  const tasks = [...(state.sessions.get(sessionId)?.execution.tasks.values() ?? [])];
  const active = tasks.filter((task) => task.lifecycle.status === "active");
  let selected = requestedTaskId
    ? active.find((task) => task.taskId === requestedTaskId)
    : active.filter((task) => task.origin.kind === "root").at(-1);
  while (selected && selected.origin.kind === "child") {
    selected = active.find(
      (task) =>
        task.taskId === (selected?.origin.kind === "child" ? selected.origin.invokedBy.taskId : ""),
    );
  }
  if (selected) {
    return {
      status: "active",
      sessionId,
      turnId: selected.turnId,
      taskId: selected.taskId,
      manifest: structuredClone(selected.program.manifest),
      input: structuredClone(selected.program.input),
      activeTasks: active.map((task) => ({
        taskId: task.taskId,
        executionEpoch: task.execution.epoch,
        attachmentId: task.execution.attachmentId,
      })),
    };
  }
  const terminal = requestedTaskId
    ? tasks.find((task) => task.taskId === requestedTaskId)
    : tasks.filter((task) => task.origin.kind === "root").at(-1);
  const outcome = terminal ? terminalOutcome(terminal) : undefined;
  return terminal && outcome
    ? { status: "terminal", taskId: terminal.taskId, outcome: structuredClone(outcome) }
    : { status: "not_found" };
}

function resolutionCapabilityFor(
  context: AuthorityDecisionFrame<AuthorityCommand>["context"],
  state: DraftState,
  sessionId: string,
  taskId: string,
  pullId: string,
): string {
  const task = taskFor(state, sessionId, taskId) as DraftTask;
  const pull = pullById(task, pullId);
  if (pull.resolutionAuthority.kind !== "attempt" && pull.resolutionAuthority.capability)
    return pull.resolutionAuthority.capability;
  const draft = new DecisionDraft(
    {
      state,
      context,
      command: {
        type: "execution.force-orphan",
        request: { sessionId, taskId, reason: "cleanup_stuck" },
      },
      facts: {},
    } as never,
    {},
  );
  return draft.resolutionCapability(task, pull, undefined);
}
