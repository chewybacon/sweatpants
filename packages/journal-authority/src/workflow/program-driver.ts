import {
  CrankError,
  DurableProgramCancellation,
  REPLAY_CHECKPOINT_CAPABILITIES,
  exactProgramKey,
  stableProgramAttachmentId,
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
import type { Json } from "@sweatpants/foundation";
import { createScope, withResolvers, type Operation } from "effection";
import {
  InstalledEffectPort,
  openProgramAttachment,
  type ProgramAttachmentHandle,
  type ProgramCommand,
  type ProgramEvent,
} from "./runtime.ts";
import { durableToolWorkflow } from "./tool-adapter.ts";

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
        if (disposition.status === "ok") return disposition.value;
        if (disposition.status === "cancelled") throw new DurableProgramCancellation();
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
  tools: DurableToolRegistry,
  options: WorkflowProgramDriverOptions = {},
): ProgramDriver {
  const handlers = options.effectHandlers;
  return {
    capabilities: REPLAY_CHECKPOINT_CAPABILITIES,

    *attach(request): Operation<ProgramAttachment> {
      const tool = tools.get(exactProgramKey(request.program));
      if (!tool) {
        throw new CrankError(
          "program_version_unavailable",
          `No exact program bundle for ${exactProgramKey(request.program)}`,
        );
      }
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
      const open = () => openProgramAttachment(request, durableToolWorkflow(tool, request.input));
      let handle: WorkflowDriverAttachmentHandle;
      if (options.detachedScope) {
        const [scope, destroyScope] = createScope();
        const ready = withResolvers<ProgramAttachmentHandle>("workflow driver attachment ready");
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
        const owned = yield* ready.operation;
        handle = new WorkflowDriverAttachmentHandle(owned, function* (reason) {
          try {
            yield* owned.close(reason);
          } finally {
            release.resolve();
            yield* owner;
            yield* destroyScope();
          }
        });
      } else {
        const owned = yield* open();
        handle = new WorkflowDriverAttachmentHandle(owned, (reason) => owned.close(reason));
      }
      return {
        attachmentId,
        taskId: request.taskId,
        driverKind: routeDriverKind(request.route),
        route: request.route,
        executionEpoch: request.executionEpoch,
        handle,
      };
    },

    *step(attachment, command): Operation<ProgramStep> {
      const handle = handleOf(attachment);

      if (command.type === "start") {
        const event = yield* handle.exchange({ type: "start", input: command.input });
        return toStep(event);
      }
      if (command.type === "authorize") {
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
        return toStep(event);
      }
      if (command.type === "ack_emission") {
        const event = yield* handle.exchange({
          type: "ack-emission",
          actionIndex: command.actionIndex,
          offset: command.offset,
        });
        return toStep(event);
      }
      if (command.type === "cancel") {
        const event = yield* handle.exchange({
          type: "cancel",
          ...(command.reason === undefined ? {} : { reason: command.reason }),
        });
        return toStep(event);
      }
      throw protocol("unknown program command");
    },

    *shutdown(attachment: ProgramAttachment, reason: ProgramShutdownReason): Operation<void> {
      yield* attachmentHandleOf(attachment).close(reason);
    },

    *manifest(program): Operation<DurableProgramManifest> {
      const tool = tools.get(exactProgramKey(program));
      if (!tool) {
        throw new CrankError(
          "program_version_unavailable",
          `No exact program bundle for ${exactProgramKey(program)}`,
        );
      }
      return tool.manifest;
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

  constructor(
    readonly value: ProgramAttachmentHandle,
    readonly dispose: (reason: ProgramShutdownReason) => Operation<void>,
  ) {}

  *close(reason: ProgramShutdownReason): Operation<void> {
    if (this.closed) return;
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

function handleOf(attachment: ProgramAttachment): ProgramAttachmentHandle {
  return attachmentHandleOf(attachment).value;
}

function routeDriverKind(route: ProgramAttachment["route"]): ProgramAttachment["driverKind"] {
  if (route === null || typeof route !== "object" || Array.isArray(route)) return "program";
  const value = route["driverKind"] ?? route["kind"];
  return typeof value === "string" && value ? value : "program";
}

function protocol(message: string): CrankError {
  return new CrankError("program_protocol_error", message);
}
