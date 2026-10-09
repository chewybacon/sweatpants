import type {
  AuthorityCommand,
  AuthorityDecisionFrame,
  AuthorityState,
  KernelTransition,
} from "../contract/authority-contract.ts";
import { decideAuthorityCommand } from "./authority-decisions.ts";
import { structuralCommandSessionId } from "../contract/authority-command-address.ts";
import type { DecisionStageDiagnostic, DecisionStageName } from "../state/authority-snapshot.ts";

/** Internal composition failure: a transition violated a kernel invariant. */
export class AuthorityCompositionError extends Error {
  readonly code = "authority_composition_invalid";

  constructor(message: string) {
    super(message);
    this.name = "AuthorityCompositionError";
  }
}

export interface AuthorityDecisionOptions {
  readonly diagnostics?: (diagnostic: DecisionStageDiagnostic) => void;
}

type Decision = <C extends AuthorityCommand>(
  frame: AuthorityDecisionFrame<C>,
) => KernelTransition<C>;

/**
 * The private, synchronous authority decision path.
 *
 * This is intentionally a fixed function composition rather than an Effection
 * API: correctness order is process-independent, cannot be installed twice,
 * and is visible directly below. Command-specific authentication and schema
 * policy stay with the typed handlers in authority-decisions.ts; these wrappers
 * enforce only invariants common to every command.
 */
export const decideAuthorityTransition: Decision = withStage(
  "decision-diagnostics",
  withStage(
    "semantic-consistency",
    withStage(
      "structural-validation",
      withStage("common-idempotency", dispatch, validateIdempotentTransition),
      validateStructure,
    ),
    validateSemanticConsistency,
  ),
);

function dispatch<C extends AuthorityCommand>(
  frame: AuthorityDecisionFrame<C>,
): KernelTransition<C> {
  const sink = frame.context.decisionDiagnostics;
  sink?.({ phase: "enter", stage: "exhaustive-dispatcher", command: frame.command.type });
  try {
    const transition = decideAuthorityCommand(frame, {
      ...(frame.context.maxOutcomeBytes === undefined
        ? {}
        : { maxOutcomeBytes: frame.context.maxOutcomeBytes }),
      ...(frame.context.emissionPolicy === undefined
        ? {}
        : { emissionPolicy: frame.context.emissionPolicy }),
    });
    sink?.({ phase: "complete", stage: "exhaustive-dispatcher", command: frame.command.type });
    return transition;
  } catch (error) {
    sink?.({
      phase: "reject",
      stage: "exhaustive-dispatcher",
      command: frame.command.type,
      category: publicCategory(error),
    });
    throw error;
  }
}

function withStage(
  name: Exclude<DecisionStageName, "exhaustive-dispatcher">,
  next: Decision,
  validate?: <C extends AuthorityCommand>(
    before: AuthorityDecisionFrame<C>,
    after: KernelTransition<C>,
  ) => void,
): Decision {
  return <C extends AuthorityCommand>(frame: AuthorityDecisionFrame<C>): KernelTransition<C> => {
    const sink = frame.context.decisionDiagnostics;
    sink?.({ phase: "enter", stage: name, command: frame.command.type });
    try {
      const transition = next(frame);
      validate?.(frame, transition);
      sink?.({ phase: "complete", stage: name, command: frame.command.type });
      return transition;
    } catch (error) {
      sink?.({
        phase: "reject",
        stage: name,
        command: frame.command.type,
        category: publicCategory(error),
      });
      throw error;
    }
  };
}

/** A duplicate is a pure replay: it changes neither durable state nor journal. */
function validateIdempotentTransition<C extends AuthorityCommand>(
  frame: AuthorityDecisionFrame<C>,
  transition: KernelTransition<C>,
): void {
  const result = transition.result as
    | { readonly status?: string; readonly duplicate?: boolean }
    | undefined;
  const duplicate = result?.status === "duplicate" || result?.duplicate === true;
  if (!duplicate) {
    return;
  }
  if (
    transition.entries.length !== 0 ||
    transition.kind !== "unchanged" ||
    transition.state !== frame.state
  ) {
    throw new AuthorityCompositionError("Duplicate decision changed authority state or journal");
  }
}

/** Every append is assigned from the shell-supplied cursor before commit. */
function validateStructure<C extends AuthorityCommand>(
  frame: AuthorityDecisionFrame<C>,
  transition: KernelTransition<C>,
): void {
  if (
    transition.kind === "unchanged" &&
    (transition.state !== frame.state || transition.entries.length !== 0)
  ) {
    throw new AuthorityCompositionError(
      "Unchanged decision proposed authority state or journal edits",
    );
  }
  const commandSession = sessionIdOf(frame.command);
  if (
    transition.entries.length > 0 &&
    ((commandSession !== undefined && frame.context.appendCursor.sessionId !== commandSession) ||
      transition.entries.some((entry) => entry.sessionId !== frame.context.appendCursor.sessionId))
  ) {
    throw new AuthorityCompositionError(
      `Append cursor session differs for ${frame.command.type}: command=${commandSession ?? "capability-bound"}, cursor=${frame.context.appendCursor.sessionId}`,
    );
  }
  transition.entries.forEach((entry, index) => {
    const expected = frame.context.appendCursor.nextOffset + index;
    if (
      entry.offset !== String(expected) ||
      entry.eventId !== `journal:${entry.sessionId}:${expected}`
    ) {
      throw new AuthorityCompositionError("Decision emitted a non-consecutive journal proposal");
    }
  });
}

/**
 * Exhaustively checks every proposed semantic record against replacement state.
 * Private control values are deliberately not projected into the journal.
 */
function validateSemanticConsistency<C extends AuthorityCommand>(
  frame: AuthorityDecisionFrame<C>,
  transition: KernelTransition<C>,
): void {
  for (const [sessionId, session] of transition.state.sessions) {
    for (const task of session.execution.tasks.values()) {
      if (task === frame.state.sessions.get(sessionId)?.execution.tasks.get(task.taskId)) {
        continue;
      }
      let expectedAction = 0;
      let expectedPull = 0;
      let expectedEmission = 0;
      for (const action of task.actions) {
        if (action.actionIndex !== expectedAction++) {
          throw new AuthorityCompositionError(
            `Task ${task.taskId} has a non-contiguous action trace`,
          );
        }
        if (action.kind === "pull") {
          if (action.pullIndex !== expectedPull++) {
            throw new AuthorityCompositionError(
              `Task ${task.taskId} has a non-contiguous pull trace`,
            );
          }
          if (action.pull.resolution.status === "settled") {
            const receipt = action.pull.resolution.settlement.receipt;
            if (receipt.sessionId !== sessionId || receipt.taskId !== task.taskId) {
              throw new AuthorityCompositionError("Pull receipt does not name its task");
            }
          }
        } else if (action.emissionIndex !== expectedEmission++) {
          throw new AuthorityCompositionError(
            `Task ${task.taskId} has a non-contiguous emission trace`,
          );
        }
      }
    }
  }
  for (const entry of transition.entries) {
    validateEntryEvidence(transition.state, entry);
  }
}

function validateEntryEvidence(
  state: AuthorityState,
  entry: KernelTransition<AuthorityCommand>["entries"][number],
): void {
  const session = state.sessions.get(entry.sessionId);
  if (!session) {
    throw new AuthorityCompositionError("Proposal names an unknown session");
  }
  const payload = entry.payload;
  const task = session.execution.tasks.get(payload.taskId);
  if (!task) {
    throw new AuthorityCompositionError("Proposal names an unknown task");
  }
  const pull =
    "pullId" in payload
      ? task.actions.find(
          (action) => action.kind === "pull" && action.pull.pullId === payload.pullId,
        )
      : undefined;
  const attempt =
    pull?.kind === "pull" && "attemptId" in payload && payload.attemptId !== undefined
      ? pull.pull.attempts.find((candidate) => candidate.attemptId === payload.attemptId)
      : undefined;

  switch (payload.type) {
    case "TaskOpened":
      if (
        task.program.artifact.id !== payload.programId ||
        task.program.artifact.version !== payload.programVersion ||
        task.program.artifact.digest !== payload.programDigest
      ) {
        throw new AuthorityCompositionError("Task proposal differs from replacement state");
      }
      return;
    case "PullRequested":
      if (
        !pull ||
        pull.kind !== "pull" ||
        pull.actionIndex !== payload.actionIndex ||
        pull.pullIndex !== payload.pullIndex ||
        pull.pull.request.proposedDescriptorDigest !== payload.descriptorDigest
      ) {
        throw new AuthorityCompositionError("Pull proposal differs from replacement state");
      }
      return;
    case "DurableEmission": {
      const emission = task.actions.find(
        (action) => action.kind === "emission" && action.actionIndex === payload.actionIndex,
      );
      if (
        !emission ||
        emission.kind !== "emission" ||
        emission.emissionIndex !== payload.emissionIndex ||
        emission.descriptorDigest !== payload.descriptorDigest
      ) {
        throw new AuthorityCompositionError("Emission proposal differs from replacement state");
      }
      return;
    }
    case "AttemptStarted":
      if (!attempt || attempt.attemptIndex !== payload.attemptIndex) {
        throw new AuthorityCompositionError(
          "Attempt-start proposal differs from replacement state",
        );
      }
      return;
    case "AttemptDetached":
      // A single transition may immediately abandon an unsafe detached
      // attempt, so next state need only prove that the attempt no longer
      // remains started.
      if (!attempt || attempt.status === "started") {
        throw new AuthorityCompositionError(
          "Attempt-detach proposal differs from replacement state",
        );
      }
      return;
    case "AttemptAbandoned":
      if (!attempt || attempt.status !== "revoked") {
        throw new AuthorityCompositionError(
          "Attempt-abandon proposal differs from replacement state",
        );
      }
      return;
    case "AttemptSuperseded":
      if (!attempt || attempt.status !== "superseded") {
        throw new AuthorityCompositionError(
          "Attempt-supersede proposal differs from replacement state",
        );
      }
      return;
    case "PullIndeterminate":
    case "AttemptOutcomeUnknown":
      if (!pull || pull.kind !== "pull") {
        throw new AuthorityCompositionError("Indeterminate proposal names an unknown pull");
      }
      return;
    case "ModelContextPrepared":
      if (
        !pull ||
        pull.kind !== "pull" ||
        pull.pull.acceptedFacts.preparationDigest !== payload.preparationDigest
      ) {
        throw new AuthorityCompositionError("Preparation proposal differs from replacement state");
      }
      return;
    case "AssistantPartialAccepted":
      if (
        !pull ||
        pull.kind !== "pull" ||
        pull.pull.acceptedFacts.assistantPartialDigest !== payload.factDigest
      ) {
        throw new AuthorityCompositionError(
          "Assistant partial proposal differs from replacement state",
        );
      }
      return;
    case "PullResolved":
      if (
        !pull ||
        pull.kind !== "pull" ||
        pull.pull.resolution.status !== "settled" ||
        pull.pull.resolution.settlement.outcomeDigest !== payload.outcomeDigest
      ) {
        throw new AuthorityCompositionError("Resolution proposal differs from replacement state");
      }
      return;
    case "RaceWinnerSelected":
      // Winner selection commits while the group is cancelling; the parent
      // pull settles only when the group resolves after losers drain.
      if (
        !pull ||
        pull.kind !== "pull" ||
        task.forkGroup?.winner === undefined ||
        task.forkGroup.members[task.forkGroup.winner.ordinal]?.taskId !== payload.winnerTaskId
      ) {
        throw new AuthorityCompositionError("Race winner proposal differs from replacement state");
      }
      return;
    case "CancellationRequested":
      if (
        task.lifecycle.status !== "active" ||
        task.lifecycle.cancellation.type === "none" ||
        task.lifecycle.cancellation.commandId !== payload.commandId
      ) {
        throw new AuthorityCompositionError("Cancellation proposal differs from replacement state");
      }
      return;
    case "CancellationPartialDiscarded":
      if (!pull || pull.kind !== "pull") {
        throw new AuthorityCompositionError("Cancellation partial proposal names an unknown pull");
      }
      return;
    case "CleanupSkipped":
      if (task.lifecycle.status !== "orphaned") {
        throw new AuthorityCompositionError("Cleanup proposal differs from replacement state");
      }
      return;
    case "TaskOrphaned":
      if (task.lifecycle.status !== "orphaned" || task.lifecycle.reason !== payload.reason) {
        throw new AuthorityCompositionError("Orphan proposal differs from replacement state");
      }
      return;
    case "AdvancementBound":
      if (
        task.execution.liveLease?.epoch !== payload.leaseEpoch ||
        task.execution.liveLease.frontierDigest !== payload.frontierDigest
      ) {
        throw new AuthorityCompositionError("Advancement bind differs from replacement state");
      }
      return;
    case "AdvancementReleased":
      if (task.execution.liveLease !== undefined) {
        throw new AuthorityCompositionError("Advancement release differs from replacement state");
      }
      return;
    case "TaskClosed":
      if (
        (task.lifecycle.status !== "closed" && task.lifecycle.status !== "cancelled") ||
        task.lifecycle.outcome !== payload.outcome
      ) {
        throw new AuthorityCompositionError("Closure proposal differs from replacement state");
      }
      return;
    case "ForkGroupOpened":
      if (
        task.forkGroup?.groupId !== payload.groupId ||
        task.forkGroup.members.length !== payload.memberTaskIds.length
      ) {
        throw new AuthorityCompositionError("Fork-open proposal differs from replacement state");
      }
      return;
    case "ForkGroupBreached":
      if (task.forkGroup?.breachedAtMs !== payload.breachedAtMs) {
        throw new AuthorityCompositionError("Fork-breach proposal differs from replacement state");
      }
      return;
    case "ForkGroupResolved":
      if (task.forkGroup?.resolution === undefined) {
        throw new AuthorityCompositionError("Fork-resolve proposal differs from replacement state");
      }
      return;
    case "ForkGroupOrphaned":
      if (task.forkGroup?.resolution?.status !== "orphaned") {
        throw new AuthorityCompositionError("Fork-orphan proposal differs from replacement state");
      }
      return;
    case "PeerDelegationCommitted":
      if (
        task.forkGroup?.members.find((member) => member.taskId === payload.memberTaskId)
          ?.delegationCorrelator !== payload.correlator
      ) {
        throw new AuthorityCompositionError(
          "Peer-delegation proposal differs from replacement state",
        );
      }
      return;
    default:
      return assertNever(payload);
  }
}

function sessionIdOf(command: AuthorityCommand): string | undefined {
  return structuralCommandSessionId(command);
}

function publicCategory(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return "internal_error";
}

function assertNever(value: never): never {
  throw new AuthorityCompositionError(
    `Unknown semantic payload ${(value as { type?: unknown }).type}`,
  );
}
