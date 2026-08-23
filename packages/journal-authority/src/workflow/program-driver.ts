import {
  CrankError,
  REPLAY_CHECKPOINT_CAPABILITIES,
  exactProgramKey,
  stableProgramAttachmentId,
  type DurableToolRegistry,
  type EffectDescriptor,
  type ProgramAttachment,
  type ProgramDriver,
  type ProgramShutdownReason,
  type ProgramStep,
} from "@sweatpants/durable-execution";
import type { Json } from "@sweatpants/foundation";
import type { Operation } from "effection";
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
export interface WorkflowEffectHandler {
  (input: Json, descriptor: EffectDescriptor): Operation<Json>;
}

export interface WorkflowProgramDriverOptions {
  /**
   * Host-configured installed-effect implementations keyed by manifest
   * effect name. Handlers dispatch through {@link InstalledEffectPort},
   * so policy middleware composes around them unchanged.
   */
  readonly effectHandlers?: ReadonlyMap<string, WorkflowEffectHandler>;
}

/**
 * Runs pinned DurableTool programs on the workflow runtime behind the
 * standard `ProgramDriver` contract, making it a drop-in replacement for
 * `createLocalProgramDriver` in every host that composes drivers by
 * registry.
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
      if (handlers !== undefined && handlers.size > 0) {
        yield* InstalledEffectPort.installDriver({
          *run(descriptor, _attempt) {
            const handler = handlers.get(descriptor.name);
            if (!handler) {
              throw new CrankError(
                "invalid_descriptor",
                `No workflow handler for effect ${descriptor.name}@${descriptor.version}`,
              );
            }
            return yield* handler(descriptor.input as Json, descriptor);
          },
        });
      }
      const handle = yield* openProgramAttachment(
        request,
        durableToolWorkflow(tool, request.input),
      );
      return {
        attachmentId: stableProgramAttachmentId(request),
        taskId: request.taskId,
        driverKind: "program",
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
      const handle = handleOf(attachment);
      // Idempotent: the attachment may have already terminated itself.
      try {
        handle.setDisposition(reason);
      } catch {
        // Terminal or disposed attachments accept no further disposition.
      }
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
    default:
      throw protocol(`unexpected attachment event ${event.type}`);
  }
}

function handleOf(attachment: ProgramAttachment): ProgramAttachmentHandle {
  // The driver contract deliberately stores the runtime payload as `unknown`;
  // this driver always attaches its own handle.
  return attachment.handle as ProgramAttachmentHandle;
}

function protocol(message: string): CrankError {
  return new CrankError("program_protocol_error", message);
}
