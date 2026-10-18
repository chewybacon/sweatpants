import {
  CrankError,
  DurableProgramCancellation,
  replayProgramRecovery,
  programRouteDriverKind,
  stableProgramAttachmentId,
  type AttachProgramRequest,
  type ProgramCheckpoint,
  type ProgramRestoreRequest,
  type RestoredProgramAttachment,
  verifyProgramReplayEntry,
  assertProgramReplayFrontier,
  type DurableProgramManifest,
  type DurableToolRegistry,
  type EffectDescriptor,
  type ProgramAttachment,
  type ProgramDriver,
  type ProgramShutdownReason,
  type RecordAttemptContext,
  type ProgramStep,
} from "@sweatpants/durable-execution";
import { durableEffectKey, type DurableEffectRegistry } from "@sweatpants/durable-effects";
import { assertJson, canonicalDigest, type Json } from "@sweatpants/foundation";
import { call, createScope, withResolvers, type Operation } from "effection";
import {
  InstalledEffectPort,
  openProgramAttachment,
  type ProgramAttachmentHandle,
  type ProgramCommand,
  type ProgramEvent,
} from "./runtime.ts";
import {
  createEffectionProgramBackend,
  type ProgramBackend,
  type ProgramComputation,
} from "./program-backend.ts";

/**
 * Host-configured implementation for one installed effect. The authority
 * validates the returned payload against the manifest output schema.
 */
export interface WorkflowEffectAttempt extends RecordAttemptContext {
  readonly sessionId: string;
  readonly taskId: string;
}

export interface WorkflowEffectHandler {
  (input: Json, descriptor: EffectDescriptor, attempt: WorkflowEffectAttempt): Operation<Json>;
}

/** Adapts execution-owned durable registrations onto workflow effect handlers. */
export function createWorkflowEffectHandlers(
  effects: DurableEffectRegistry,
): ReadonlyMap<string, WorkflowEffectHandler> {
  return new Map(
    [...effects.values()].map((registration) => [
      registration.definition.name,
      function* (input, descriptor, attempt) {
        const exact = effects.get(durableEffectKey(descriptor.name, descriptor.version));
        if (!exact) {
          throw new CrankError(
            "effect_placement_unavailable",
            `Execution effect ${descriptor.name}@${descriptor.version} is unavailable`,
          );
        }
        const disposition = yield* exact.handler(input, {
          sessionId: attempt.sessionId,
          taskId: attempt.taskId,
          pullId: attempt.pullId,
          attemptId: attempt.attemptId,
          cancellation: attempt.cancellation,
          resolver: descriptor.resolver,
        });
        if (disposition.status === "ok") {
          return disposition.value;
        }
        if (disposition.status === "cancelled") {
          throw new DurableProgramCancellation();
        }
        throw new CrankError(
          disposition.error.code,
          disposition.error.message,
          disposition.error.details,
        );
      } satisfies WorkflowEffectHandler,
    ]),
  );
}

export interface WorkflowProgramDriverOptions {
  /** Owns attachments independently of the caller operation (worker/remote evaluators). */
  readonly detachedScope?: boolean;
  /**
   * Host-configured installed-effect implementations keyed by manifest
   * effect name. Handlers dispatch through {@link InstalledEffectPort},
   * so policy middleware composes around them unchanged.
   */
  readonly effectHandlers?: ReadonlyMap<string, WorkflowEffectHandler>;
}

/**
 * Runs pinned DurableTool programs on the workflow runtime behind the
 * standard `ProgramDriver` contract for hosts that compose evaluator
 * transports by registry.
 */
export function createWorkflowProgramDriver(
  programs: DurableToolRegistry | ProgramBackend,
  options: WorkflowProgramDriverOptions = {},
): ProgramDriver {
  const backend = "open" in programs ? programs : createEffectionProgramBackend(programs);
  const handlers = options.effectHandlers;
  function* attachProgram(
    request: AttachProgramRequest,
    checkpoint?: Extract<ProgramCheckpoint, { kind: "continuation" }>,
    actionIndex = 0,
  ): Operation<ProgramAttachment> {
    // Installed-effect handlers are host configuration: install them into
    // the caller's scope so every attachment opened here can reach them.
    if (handlers !== undefined) {
      yield* InstalledEffectPort.installDriver({
        *run(descriptor, attempt) {
          const handler = handlers.get(descriptor.name);
          if (!handler) {
            throw new CrankError(
              "effect_placement_unavailable",
              `No execution handler for effect ${descriptor.name}@${descriptor.version}`,
            );
          }
          return yield* handler(descriptor.input as Json, descriptor, {
            ...attempt,
            sessionId: request.sessionId,
            taskId: request.taskId,
          });
        },
      });
    }
    const attachmentId = stableProgramAttachmentId(request);
    const open = function* () {
      const computation = yield* backend.open(request, checkpoint);
      const owned = yield* openProgramAttachment(request, computation, actionIndex);
      return { owned, computation };
    };
    let handle: WorkflowDriverAttachmentHandle;
    if (options.detachedScope) {
      const [scope, destroyScope] = createScope();
      const ready = withResolvers<{
        owned: ProgramAttachmentHandle;
        computation: ProgramComputation;
      }>("workflow driver attachment ready");
      const release = withResolvers<void>("workflow driver attachment release");
      const owner = scope.run(function* () {
        try {
          ready.resolve(yield* open());
          yield* release.operation;
        } catch (error) {
          ready.reject(error instanceof Error ? error : new Error("Workflow attach failed"));
          throw error;
        }
      });
      const { owned, computation } = yield* ready.operation;
      handle = new WorkflowDriverAttachmentHandle(
        structuredClone(request),
        computation,
        owned,
        function* (reason) {
          try {
            yield* owned.close(reason);
          } finally {
            try {
              yield* computation.dispose();
            } finally {
              release.resolve();
              try {
                yield* owner;
              } finally {
                yield* destroyScope();
              }
            }
          }
        },
      );
    } else {
      const { owned, computation } = yield* open();
      handle = new WorkflowDriverAttachmentHandle(
        structuredClone(request),
        computation,
        owned,
        function* (reason) {
          try {
            yield* owned.close(reason);
          } finally {
            yield* computation.dispose();
          }
        },
      );
    }
    return {
      attachmentId,
      taskId: request.taskId,
      driverKind: programRouteDriverKind(request.route),
      route: request.route,
      executionEpoch: request.executionEpoch,
      handle,
    };
  }
  return {
    evaluatorKind: "program",
    capabilities: backend.capabilities,

    attach(request) {
      return attachProgram(request);
    },

    *step(attachment, command): Operation<ProgramStep> {
      const state = attachmentHandleOf(attachment);
      const handle = state.value;
      function present(event: ProgramEvent): ProgramStep {
        const step = toStep(event);
        state.frontier = structuredClone(step);
        return step;
      }

      if (command.type === "start") {
        const event = yield* handle.exchange({ type: "start", input: command.input });
        return present(event);
      }
      if (command.type === "authorize") {
        state.attemptPending = true;
        if (command.descriptor === undefined) {
          throw protocol("authorization without a descriptor");
        }
        const authorizeCommand: ProgramCommand = {
          type: "authorize-record",
          actionIndex: command.actionIndex,
          pullId: command.pullId,
          attemptId: command.attemptId,
          descriptor: command.descriptor,
          ...(command.placement === undefined ? {} : { placement: command.placement }),
        };
        const event = yield* handle.exchange(authorizeCommand);
        if (event.type !== "record-attempt-completed") {
          throw protocol(`expected attempt completion, got ${event.type}`);
        }
        return {
          type: "operation",
          actionIndex: event.actionIndex,
          descriptor: command.descriptor,
          authorizedOutcome: event.outcome,
        };
      }
      if (command.type === "resume") {
        const event = yield* handle.exchange({
          type: "resume-record",
          actionIndex: command.actionIndex,
          outcome: command.outcome,
          receipt: command.receipt,
          replayed: command.replayed,
        });
        state.attemptPending = false;
        return present(event);
      }
      if (command.type === "ack_emission") {
        const event = yield* handle.exchange({
          type: "ack-emission",
          actionIndex: command.actionIndex,
          offset: command.offset,
        });
        return present(event);
      }
      if (command.type === "cancel") {
        state.checkpointable = false;
        const event = yield* handle.exchange({
          type: "cancel",
          ...(command.reason === undefined ? {} : { reason: command.reason }),
        });
        return present(event);
      }
      throw protocol("unknown program command");
    },

    *checkpoint(attachment) {
      const handle = attachmentHandleOf(attachment);
      if (handle.closed || !handle.frontier) {
        throw protocol("checkpoint without a live frontier");
      }
      if (!handle.checkpointable || handle.attemptPending) {
        return { kind: "replay" };
      }
      const checkpoint = yield* handle.computation.capture();
      if (checkpoint.kind === "replay") {
        return checkpoint;
      }
      return {
        ...checkpoint,
        state: assertJson({
          identity: recoveryIdentity(handle.request),
          index: handle.frontier.actionIndex,
          backend: checkpoint.state,
          frontierDigest: canonicalDigest(handle.frontier),
        }),
      };
    },

    *restore(request: ProgramRestoreRequest): Operation<RestoredProgramAttachment> {
      if (request.checkpoint.kind === "replay") {
        return yield* replayProgramRecovery.restore.call(this, request);
      }
      const checkpoint = request.checkpoint;
      const state = checkpoint.state;
      if (
        checkpoint.format !== backend.capabilities.continuation?.format ||
        checkpoint.programDigest !== request.attach.program.digest ||
        !state ||
        typeof state !== "object" ||
        Array.isArray(state) ||
        state.identity !== recoveryIdentity(request.attach) ||
        typeof state.index !== "number" ||
        !Number.isSafeInteger(state.index) ||
        state.index < 0 ||
        state.index !== checkpoint.resumeAfter.actionIndex + 1 ||
        typeof state.frontierDigest !== "string" ||
        !("backend" in state)
      ) {
        throw protocol("Checkpoint identity or position differs");
      }
      const attachment = yield* attachProgram(
        request.attach,
        { ...checkpoint, state: state.backend },
        state.index,
      );
      let success = false;
      try {
        let frontier = yield* this.step(attachment, { type: "start", input: request.attach.input });
        if (canonicalDigest(frontier) !== state.frontierDigest) {
          throw new CrankError("replay_diverged", "Restored workflow frontier differs");
        }
        let previous = checkpoint.resumeAfter.replayChainDigest;
        let through = checkpoint.resumeAfter.actionIndex;
        const iterator =
          request.replay[Symbol.iterator]?.() ?? request.replay[Symbol.asyncIterator]?.();
        if (!iterator) {
          throw protocol("Replay source has no iterator");
        }
        let exhausted = false;
        try {
          for (;;) {
            const next = yield* call(() => Promise.resolve(iterator.next()));
            if (next.done) {
              exhausted = true;
              break;
            }
            const entry = next.value;
            verifyProgramReplayEntry(request.replayChainSeed, entry, previous);
            assertProgramReplayFrontier(frontier, entry);
            frontier = yield* this.step(
              attachment,
              entry.type === "operation"
                ? {
                    type: "resume",
                    actionIndex: entry.actionIndex,
                    outcome: entry.outcome,
                    receipt: entry.receipt,
                    replayed: true,
                  }
                : { type: "ack_emission", actionIndex: entry.actionIndex, offset: entry.offset },
            );
            previous = entry.entryDigest;
            through = entry.actionIndex;
          }
        } finally {
          const close = iterator.return?.bind(iterator);
          if (!exhausted && close) {
            yield* call(() => Promise.resolve(close()));
          }
        }
        if (
          through !== request.replayedThroughActionIndex ||
          previous !== request.replayChainDigest
        ) {
          throw new CrankError(
            "replay_diverged",
            "Recovery did not reach requested journal position",
          );
        }
        success = true;
        return {
          attachment,
          frontier,
          frontierDigest: canonicalDigest(frontier),
          replayedThroughActionIndex: through,
          replayChainDigest: previous,
        };
      } finally {
        if (!success) {
          yield* this.shutdown(attachment, "failed");
        }
      }
    },

    *shutdown(attachment: ProgramAttachment, reason: ProgramShutdownReason): Operation<void> {
      yield* attachmentHandleOf(attachment).close(reason);
    },

    *manifest(program): Operation<DurableProgramManifest> {
      return yield* backend.manifest(program);
    },
  };
}

function toStep(event: ProgramEvent): ProgramStep {
  switch (event.type) {
    case "record-proposed":
    case "record-attempt-completed": {
      if (event.type === "record-proposed") {
        return {
          type: "operation",
          actionIndex: event.actionIndex,
          descriptor: event.descriptor,
        };
      }
      throw protocol("attempt events settle inside the activation, not via step");
    }
    case "emission-proposed":
      return {
        type: "emission",
        actionIndex: event.actionIndex,
        descriptor: event.descriptor,
      };
    case "completed":
      return {
        type: "completed",
        actionIndex: event.actionIndex,
        value: event.value,
      };
    case "failed":
      return {
        type: "failed",
        actionIndex: event.actionIndex,
        error: event.error,
      };
    default:
      throw protocol(`unexpected attachment event ${event.type}`);
  }
}

class WorkflowDriverAttachmentHandle {
  closed = false;
  checkpointable = true;
  attemptPending = false;
  frontier?: ProgramStep;

  constructor(
    readonly request: AttachProgramRequest,
    readonly computation: ProgramComputation,
    readonly value: ProgramAttachmentHandle,
    readonly dispose: (reason: ProgramShutdownReason) => Operation<void>,
  ) {}

  *close(reason: ProgramShutdownReason): Operation<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    yield* this.dispose(reason);
  }

  toJSON(): never {
    throw protocol("workflow driver attachments are runtime-only");
  }
}

function attachmentHandleOf(attachment: ProgramAttachment): WorkflowDriverAttachmentHandle {
  if (!(attachment.handle instanceof WorkflowDriverAttachmentHandle)) {
    throw protocol("attachment belongs to another driver");
  }
  return attachment.handle;
}

function protocol(message: string): CrankError {
  return new CrankError("program_protocol_error", message);
}

function recoveryIdentity(request: AttachProgramRequest): string {
  return canonicalDigest({
    sessionId: request.sessionId,
    taskId: request.taskId,
    program: request.program,
    input: request.input,
  });
}
