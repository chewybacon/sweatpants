import {
  CrankError,
  assertInlineSize,
} from "@sweatpants/durable-execution";
import type { Json } from "@sweatpants/foundation";

import type {
  AuthorityCommand,
  AuthorityDecisionFrame,
  AuthorityQuery,
  AuthorityState,
  QueryResult,
  TaskState,
} from "./authority-contract.ts";
import type {
  AuthorizeModelDispatchRequest,
  AuthorizeModelDispatchResult,
  DurableOperationState,
  DurableTaskExecutionState,
  DurableTaskRecoveryState,
  RecoverableSession,
  ValidateElicitResponseRequest,
  ValidateElicitResponseResult,
} from "./authority-types.ts";
import { DecisionDraft } from "./decision-draft.ts";
import {
  cloneAuthorityState,
  currentAttempt,
  findPullById,
  findTaskPullById,
  pullAudience,
  pullById,
  taskFor,
  terminalCancellation,
  terminalOutcome,
  type DraftTask,
} from "./decision-state.ts";
import { planForestReplay } from "./forest-replay.ts";
import { parseRegisteredSchema } from "./schema-registry.ts";
import {
  identityConflict,
  isModelSampleDescriptor,
  manifestSchemaDigests,
  modelPullOwnerFence,
  parseProgramElicitResult,
  sanitizeCancellationReason,
  sortedStrings,
} from "./authority-support.ts";

/** Complete read-only Authority surface. Query modules never receive a draft. */
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
    case "forest.replay-plan":
      result = planForestReplay(state, query.sessionId, context.journalHeadDigest, context.nowMs);
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
    case "task.lifecycle":
      result = { status: taskFor(state, query.sessionId, query.taskId).lifecycle.status };
      break;
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
        cloneAuthorityState(state),
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

function matchesModelPreparationOwner(
  task: TaskState,
  pull: import("./authority-contract.ts").PullState,
  expectedOwnerFence: string,
): boolean {
  const attempt = currentAttempt(pull);
  return attempt
    ? attempt.attemptId === expectedOwnerFence
    : pull.request.proposedDescriptor.kind === "sample" &&
        expectedOwnerFence === modelPullOwnerFence(pull.pullId, task.execution.epoch);
}

function authorizeModelDispatch(
  state: AuthorityState,
  request: AuthorizeModelDispatchRequest,
): AuthorizeModelDispatchResult {
  const found = findTaskPullById(state, request.taskId, request.pullId);
  if (found === undefined) return { status: "pull_not_pending" };
  const [, task, pull] = found;
  if (
    task.lifecycle.status !== "active" ||
    pull.resolution.status !== "open" ||
    pull.resolution.revoked
  ) return { status: "pull_not_pending" };
  if (!isModelSampleDescriptor(pull.request.proposedDescriptor)) {
    return { status: "identity_conflict" };
  }
  if (!matchesModelPreparationOwner(task, pull, request.expectedOwnerFence)) {
    return { status: "stale_owner" };
  }
  const preparation = pull.acceptedFacts.preparation;
  if (preparation === undefined) return { status: "not_prepared" };
  if (preparation.executionId !== request.executionId) return { status: "identity_conflict" };
  if (preparation.invocationDigest !== request.invocationDigest) {
    return {
      status: "identity_conflict",
      conflict: identityConflict(
        "model-context",
        `${request.executionId}/${request.taskId}/${request.pullId}`,
        request.invocationDigest,
        preparation.invocationDigest,
      ),
    };
  }
  return { status: "authorized", fact: structuredClone(preparation) };
}

function validateElicitResponse(
  state: AuthorityState,
  context: AuthorityDecisionFrame<AuthorityCommand>["context"],
  request: ValidateElicitResponseRequest,
): ValidateElicitResponseResult {
  const found = findPullById(state, request.pullId);
  if (found === undefined) return { status: "not_pending" };
  const [sessionId, task, pull] = found;
  if (
    sessionId !== request.sessionId ||
    task.lifecycle.status !== "active" ||
    pull.request.proposedDescriptor.kind !== "elicit" ||
    pull.resolution.status !== "open" ||
    pull.resolution.revoked
  ) return { status: "not_pending" };
  if (request.participantId !== pullAudience(pull)) return { status: "audience_invalid" };
  const descriptorContext = pull.request.proposedDescriptor.context;
  if (descriptorContext !== null && typeof descriptorContext === "object" && !Array.isArray(descriptorContext)) {
    const expiresAt = descriptorContext["expiresAt"];
    if (
      typeof expiresAt === "string" &&
      Number.isFinite(Date.parse(expiresAt)) &&
      context.nowMs >= Date.parse(expiresAt)
    ) return { status: "expired" };
  }
  const envelope = parseProgramElicitResult(request.completion);
  if (envelope === undefined) return { status: "schema_validation_failed" };
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

function nonterminalSchemaDigests(state: AuthorityState): string[] {
  const result = new Set<string>();
  for (const session of state.sessions.values()) {
    for (const task of session.execution.tasks.values()) {
      if (task.lifecycle.status !== "active") continue;
      for (const digest of manifestSchemaDigests(task.program.manifest)) result.add(digest);
      for (const action of task.actions) {
        if (action.kind === "pull" && action.pull.resolution.status === "open") {
          result.add(action.pull.request.resultSchemaDigest);
        }
      }
    }
  }
  return sortedStrings(result);
}

function recoverableSessions(state: AuthorityState, now: number): RecoverableSession[] {
  const result = new Map<string, RecoverableSession>();
  for (const [id, session] of state.sessions) {
    if (
      session.control.runnable &&
      (session.control.activationNotBeforeMs === undefined || now >= session.control.activationNotBeforeMs)
    ) result.set(id, { sessionId: id, reason: "runnable" });
    if (session.control.activationLease !== undefined && now >= session.control.activationLease.expiresAtMs) {
      result.set(id, { sessionId: id, reason: "expired_activation" });
    }
  }
  return [...result.values()].sort((left, right) => left.sessionId.localeCompare(right.sessionId));
}

/** Turn identity is admitted data; task-id text is never parsed. */
function rootTaskCount(state: AuthorityState, sessionId: string): number {
  return [...(state.sessions.get(sessionId)?.execution.tasks.values() ?? [])].filter(
    (task) => task.origin.kind === "root",
  ).length;
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
      : { catalog: structuredClone(task.execution.catalog), catalogDigest: task.execution.catalogDigest! }),
  };
}

function operationState(
  state: AuthorityState,
  sessionId: string,
  taskId: string,
  pullId: string,
): DurableOperationState {
  const task = state.sessions.get(sessionId)?.execution.tasks.get(taskId);
  const action = task?.actions.find(
    (candidate) => candidate.kind === "pull" && candidate.pull.pullId === pullId,
  );
  if (action?.kind !== "pull") return { status: "not_found" };
  return {
    status: "found",
    descriptor: structuredClone(action.pull.request.proposedDescriptor),
    audience: pullAudience(action.pull),
    ...(action.pull.resolution.status === "settled"
      ? { outcome: structuredClone(action.pull.resolution.settlement.outcome) }
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
  while (selected?.origin.kind === "child") {
    const parentTaskId = selected.origin.invokedBy.taskId;
    selected = active.find((task) => task.taskId === parentTaskId);
  }
  if (selected !== undefined) {
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
  const outcome = terminal === undefined ? undefined : terminalOutcome(terminal);
  return terminal !== undefined && outcome !== undefined
    ? { status: "terminal", taskId: terminal.taskId, outcome: structuredClone(outcome) }
    : { status: "not_found" };
}

function resolutionCapabilityFor(
  context: AuthorityDecisionFrame<AuthorityCommand>["context"],
  state: ReturnType<typeof cloneAuthorityState>,
  sessionId: string,
  taskId: string,
  pullId: string,
): string {
  const task = taskFor(state, sessionId, taskId) as DraftTask;
  const pull = pullById(task, pullId);
  if (pull.resolutionAuthority.kind !== "attempt" && pull.resolutionAuthority.capability) {
    return pull.resolutionAuthority.capability;
  }
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

function assertNever(value: never): never {
  throw new CrankError(
    "invalid_command",
    `Unknown authority query ${(value as { readonly type?: string }).type ?? "missing"}`,
  );
}
