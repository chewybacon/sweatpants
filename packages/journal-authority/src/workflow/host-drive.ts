import { scoped, type Operation } from "effection";
import type { DurableEffectRegistration } from "@sweatpants/durable-effects";
import type { AttachProgramRequest, ProgramRunResult } from "@sweatpants/durable-execution";
import { DurableProgramCancellation, CrankError } from "@sweatpants/durable-execution";
import { InstalledEffectPort } from "./runtime.ts";
import type { JournalAuthorityContract } from "../authority-contract.ts";
import type { Json } from "@sweatpants/foundation";
import type {
  AppendEmissionRequest,
  CompleteTaskRequest,
  ResolveOperationRequest,
  ResolveOperationResult,
  ReserveOperationRequest,
  ReserveOperationResult,
  CompleteTaskResult,
} from "../authority-types.ts";
import { openProgramAttachment, type ProgramAttachmentHandle, type Workflow } from "./runtime.ts";

/**
 * Adapts the port-facing command contract onto the HostAuthority surface.
 * Kernel-owned so hosts (facade included) share one implementation.
 */
export function hostAuthority(authority: JournalAuthorityContract): HostAuthority {
  return {
    reserve(request) {
      return authority.command({
        type: "execution.reserve-pull",
        request,
      }) as Operation<ReserveOperationResult>;
    },
    resolve(request) {
      return authority.command({
        type: "execution.resolve-pull",
        request,
      }) as Operation<ResolveOperationResult>;
    },
    emit(request) {
      return authority.command({ type: "execution.append-emission", request }) as Operation<{
        readonly offset: string;
      }>;
    },
    complete(request) {
      return authority.command({
        type: "execution.complete-task",
        request,
      }) as Operation<CompleteTaskResult>;
    },
  };
}

/** Minimal authority surface the parked-activation drive loop needs. */
export interface HostAuthority {
  reserve(request: ReserveOperationRequest): Operation<ReserveOperationResult>;
  resolve(request: ResolveOperationRequest): Operation<ResolveOperationResult>;
  emit(request: AppendEmissionRequest): Operation<{ readonly offset: string }>;
  complete(request: CompleteTaskRequest): Operation<CompleteTaskResult>;
}

export interface DriveActivationRequest {
  readonly attach: AttachProgramRequest;
  readonly workflow: () => Workflow<Json>;
  readonly authority: HostAuthority;
  readonly programCapability: string;
  /**
   * Invoked after an inline effect settles and its resolution is journaled.
   * Hosts use it for post-resolution bookkeeping (outcome acknowledgement).
   */
  readonly onEffectResolved?: (info: {
    readonly pullId: string;
    readonly attemptId: string;
    readonly outcomeDigest: string;
    readonly effect: { readonly name: string; readonly version: string };
  }) => Operation<void>;
}

/**
 * Runs one scoped workflow attachment until it parks or reaches a terminal
 * event. Terminal events close the authority task before this Operation
 * returns; resource disposal is owned here rather than by each caller.
 */
export function driveActivation(request: DriveActivationRequest): Operation<ProgramRunResult> {
  return scoped(function* () {
    const handle = yield* openProgramAttachment(request.attach, request.workflow);
    return yield* driveAttachment(
      handle,
      request.authority,
      request.attach,
      request.programCapability,
      request.onEffectResolved,
    );
  });
}

function* driveAttachment(
  handle: ProgramAttachmentHandle,
  authority: HostAuthority,
  attach: AttachProgramRequest,
  programCapability: string,
  onEffectResolved?: DriveActivationRequest["onEffectResolved"],
): Operation<ProgramRunResult> {
  const { sessionId, taskId, input } = attach;
  let event = yield* handle.exchange({ type: "start", input });
  let pullIndex = 0;
  while (event.type !== "completed" && event.type !== "failed") {
    if (event.type === "emission-proposed") {
      const receipt = yield* authority.emit({
        sessionId,
        taskId,
        actionIndex: event.actionIndex,
        descriptor: event.descriptor,
        programCapability,
      });
      event = yield* handle.exchange({
        type: "ack-emission",
        actionIndex: event.actionIndex,
        offset: receipt.offset,
      });
      continue;
    }
    if (event.type !== "record-proposed") {
      throw new Error(`unexpected attachment event ${event.type}`);
    }
    const proposed = event;
    const reserved = yield* authority.reserve({
      sessionId,
      turnId: turnIdFor(taskId),
      taskId,
      actionIndex: proposed.actionIndex,
      pullIndex,
      descriptor: proposed.descriptor,
      programCapability,
    });
    if (reserved.status === "pending") {
      // Parking is host policy: a pending reservation ends this activation;
      // a later attachment replays the settled history.
      return {
        state: "parked",
        reason: reserved.reason,
        pullId: reserved.pullId,
      };
    }
    if (reserved.status === "resolved") {
      pullIndex += 1;
      event = yield* handle.exchange({
        type: "resume-record",
        actionIndex: event.actionIndex,
        outcome: reserved.outcome,
        receipt: { ...reserved.receipt!, status: "accepted" },
        replayed: true,
      });
      continue;
    }
    if (reserved.status !== "authorized") {
      throw new Error(`unexpected reservation state`);
    }
    pullIndex += 1;
    const attempted = yield* handle.exchange({
      type: "authorize-record",
      actionIndex: event.actionIndex,
      pullId: reserved.pullId,
      attemptId: reserved.attemptId,
      descriptor: event.descriptor,
    });
    if (attempted.type !== "record-attempt-completed") {
      throw new Error(`expected attempt completion, got ${attempted.type}`);
    }
    const resolved = yield* authority.resolve({
      capability: reserved.resolutionCapability,
      audience: "program-execution",
      outcome: attempted.outcome,
    });
    if (resolved.status !== "accepted") {
      throw new Error(`resolution rejected: ${resolved.status}`);
    }
    if (onEffectResolved && proposed.descriptor.kind === "effect") {
      yield* onEffectResolved({
        pullId: reserved.pullId,
        attemptId: reserved.attemptId,
        outcomeDigest: resolved.receipt.outcomeDigest,
        effect: {
          name: proposed.descriptor.name,
          version: proposed.descriptor.version,
        },
      });
    }
    event = yield* handle.exchange({
      type: "resume-record",
      actionIndex: event.actionIndex,
      outcome: attempted.outcome,
      receipt: {
        sessionId,
        taskId,
        pullId: reserved.pullId,
        resolutionOffset: resolved.receipt.resolutionOffset,
        outcomeDigest: resolved.receipt.outcomeDigest,
        status: "accepted",
      },
      replayed: false,
    });
  }
  if (event.type === "failed") {
    if (event.error.code === "program_cancelled") {
      // Cancellation surfaces as a serialized failure event; the authority
      // closes cancelled tasks through the dedicated outcome shape.
      yield* authority.complete({
        sessionId,
        taskId,
        actionIndex: event.actionIndex,
        outcome: { status: "cancelled" },
        programCapability,
      });
      return { state: "cancelled" };
    }
    yield* authority.complete({
      sessionId,
      taskId,
      actionIndex: event.actionIndex,
      outcome: { status: "error", error: event.error },
      programCapability,
    });
    return { state: "failed", error: event.error };
  }
  const closed = yield* authority.complete({
    sessionId,
    taskId,
    actionIndex: event.actionIndex,
    outcome: { status: "ok", value: event.value },
    programCapability,
  });
  if (closed.status === "rejected") {
    // Program-authored value refused by policy: close through the standard
    // error envelope so the journal records TaskClosed{error} uniformly.
    const error = { code: closed.code, message: closed.message };
    yield* authority.complete({
      sessionId,
      taskId,
      actionIndex: event.actionIndex,
      outcome: { status: "error", error },
      programCapability,
    });
    return { state: "failed", error };
  }
  return { state: "completed", value: event.value };
}

/**
 * Installs durable-effect registrations onto the workflow runtime's
 * installed-effect port. Registration handlers speak the durable registry
 * envelope (`OperationOutcome`); this adapter unwraps it for authored bodies.
 */
export function* installEffectRegistrations(
  identity: { readonly sessionId: string; readonly taskId: string },
  registrations: readonly DurableEffectRegistration[],
): Operation<void> {
  yield* InstalledEffectPort.installDriver({
    *run(descriptor, attempt) {
      const reg =
        registrations.find(
          (r) =>
            r.definition.name === descriptor.name && r.definition.version === descriptor.version,
        ) ?? registrations.find((r) => r.definition.name === descriptor.name);
      if (!reg) {
        throw new CrankError(
          "effect_handler_missing",
          `No installed-effect handler for ${descriptor.name}@${descriptor.version}`,
        );
      }
      const context = {
        sessionId: identity.sessionId,
        taskId: identity.taskId,
        pullId: attempt.pullId,
        attemptId: attempt.attemptId,
        cancellation: attempt.cancellation,
        resolver: descriptor.resolver,
      };
      const outcome = yield* reg.handler(descriptor.input, context);
      if (outcome.status === "ok") {
        return outcome.value;
      }
      if (outcome.status === "cancelled") {
        throw new DurableProgramCancellation();
      }
      throw new CrankError(outcome.error.code, outcome.error.message, outcome.error.details);
    },
  });
}

function turnIdFor(taskId: string): string {
  const separator = taskId.indexOf("/");
  return separator === -1 ? "turn-0" : taskId.slice(0, separator);
}
