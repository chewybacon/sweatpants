import { type Operation } from "effection";
import type { DurableEffectRegistration } from "@sweatpants/durable-effects";
import {
  CrankError,
  DurableProgramCancellation,
  ProgramDriverRegistryContext,
  REPLAY_CHECKPOINT_CAPABILITIES,
  replayProgramRecovery,
  programRouteDriverKind,
  stableProgramAttachmentId,
  type AdvancementResult,
  type AttachProgramRequest,
  type ProgramAttachment,
  type ProgramDriver,
  type ProgramShutdownReason,
  type ProgramStep,
} from "@sweatpants/durable-execution";
import { type Json, digestCanonicalJson } from "@sweatpants/foundation";

import type { JournalAuthorityContract } from "../contract/authority-contract.ts";
import { InstalledEffectPort } from "./runtime.ts";
import {
  openProgramAttachment,
  type ProgramAttachmentHandle,
  type ProgramCommand,
  type ProgramEvent,
  type Workflow,
} from "./runtime.ts";
import { driveProgramDriverActivation } from "./driver-drive.ts";

/** Canonical Authority role consumed by host composition. */
export type AuthorityPort = JournalAuthorityContract;

/** Compatibility-free adapter: callers now pass the production port unchanged. */
export function hostAuthority(authority: JournalAuthorityContract): AuthorityPort {
  return authority;
}

export interface DriveActivationRequest {
  readonly attach: AttachProgramRequest;
  readonly workflow: () => Workflow<Json>;
  readonly authority: AuthorityPort;
  readonly onEffectResolved?: (info: {
    readonly pullId: string;
    readonly attemptId: string;
    readonly outcomeDigest: string;
    readonly effect: { readonly name: string; readonly version: string };
  }) => Operation<void>;
}

/**
 * Adapts an in-process workflow factory to the one ProgramDriver spine.
 * There is no second replay/activation pump: planner, replay walker, Mandate
 * bind, relative live commands, and settlement replay are shared verbatim.
 */
export function driveActivation(request: DriveActivationRequest): Operation<AdvancementResult> {
  const driver = workflowFactoryDriver(request.workflow);
  const kind = programRouteDriverKind(request.attach.route);
  const registry = new Map<string, ProgramDriver>([[kind, driver]]);
  return ProgramDriverRegistryContext.with(registry, function* () {
    return yield* driveProgramDriverActivation({
      authority: request.authority,
      driver,
      attach: request.attach,
      advancement: {
        effects: {
          *route() {
            return "execution";
          },
          *executeHost() {
            throw new CrankError("effect_placement_unavailable");
          },
          /* CONDITIONAL-SPREAD: Expose acknowledge only when its backing capability exists; callers inspect supported methods. */
          ...(request.onEffectResolved === undefined
            ? {}
            : {
                *acknowledge({ authorization, outcome }) {
                  yield* request.onEffectResolved!({
                    pullId: authorization.pullId,
                    attemptId: authorization.attemptId,
                    outcomeDigest: digestCanonicalJson(outcome),
                    effect: {
                      name: authorization.descriptor.name,
                      version: authorization.descriptor.version,
                    },
                  });
                },
              }),
        },
      },
    });
  });
}

function workflowFactoryDriver(workflow: () => Workflow<Json>): ProgramDriver {
  return {
    evaluatorKind: "program",
    capabilities: REPLAY_CHECKPOINT_CAPABILITIES,
    ...replayProgramRecovery,
    *attach(request): Operation<ProgramAttachment> {
      const handle = yield* openProgramAttachment(request, workflow);
      return {
        attachmentId: stableProgramAttachmentId(request),
        taskId: request.taskId,
        driverKind: programRouteDriverKind(request.route),
        route: request.route,
        executionEpoch: request.executionEpoch,
        handle,
      };
    },
    *step(attachment, command): Operation<ProgramStep> {
      const handle = attachmentHandle(attachment);
      if (command.type === "start") {
        return toStep(yield* handle.exchange({ type: "start", input: command.input }));
      }
      if (command.type === "resume") {
        return toStep(
          yield* handle.exchange({
            type: "resume-record",
            actionIndex: command.actionIndex,
            outcome: command.outcome,
            receipt: command.receipt,
            replayed: command.replayed,
          }),
        );
      }
      if (command.type === "authorize") {
        if (command.descriptor === undefined) {
          throw new CrankError("program_protocol_error", "Authorization has no descriptor");
        }
        const runtimeCommand: ProgramCommand = {
          type: "authorize-record",
          actionIndex: command.actionIndex,
          pullId: command.pullId,
          attemptId: command.attemptId,
          descriptor: command.descriptor,
          /* CONDITIONAL-SPREAD: Omit absent placement from journal commands, decisions, and replay records; explicit undefined is not a portable JSON value. */
          ...(command.placement === undefined ? {} : { placement: command.placement }),
        };
        const event = yield* handle.exchange(runtimeCommand);
        if (event.type !== "record-attempt-completed") {
          throw new CrankError("program_protocol_error", "Attempt did not complete");
        }
        return {
          type: "operation",
          actionIndex: event.actionIndex,
          descriptor: command.descriptor,
          authorizedOutcome: event.outcome,
        };
      }
      if (command.type === "ack_emission") {
        return toStep(
          yield* handle.exchange({
            type: "ack-emission",
            actionIndex: command.actionIndex,
            offset: command.offset,
          }),
        );
      }
      if (command.type === "cancel") {
        return toStep(
          yield* handle.exchange({
            type: "cancel",
            /* CONDITIONAL-SPREAD: Omit absent reason from journal commands, decisions, and replay records; explicit undefined is not a portable JSON value. */
            ...(command.reason === undefined ? {} : { reason: command.reason }),
          }),
        );
      }
      return assertNever(command);
    },
    *shutdown(attachment, reason: ProgramShutdownReason): Operation<void> {
      yield* attachmentHandle(attachment).close(reason);
    },
  };
}

function attachmentHandle(attachment: ProgramAttachment): ProgramAttachmentHandle {
  if (!(attachment.handle instanceof Object) || !("exchange" in attachment.handle)) {
    throw new CrankError("program_protocol_error", "Workflow attachment handle is invalid");
  }
  return attachment.handle as ProgramAttachmentHandle;
}

function toStep(event: ProgramEvent): ProgramStep {
  switch (event.type) {
    case "record-proposed":
      return { type: "operation", actionIndex: event.actionIndex, descriptor: event.descriptor };
    case "emission-proposed":
      return { type: "emission", actionIndex: event.actionIndex, descriptor: event.descriptor };
    case "completed":
      return { type: "completed", actionIndex: event.actionIndex, value: event.value };
    case "failed":
      return { type: "failed", actionIndex: event.actionIndex, error: event.error };
    case "record-attempt-completed":
    case "emission-recorded":
      throw new CrankError("program_protocol_error", "Internal event escaped its exchange");
    default:
      return assertNever(event);
  }
}

function assertNever(value: never): never {
  throw new CrankError(
    "program_protocol_error",
    `Unknown workflow protocol value ${String(value)}`,
  );
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
      const registration =
        registrations.find(
          (candidate) =>
            candidate.definition.name === descriptor.name &&
            candidate.definition.version === descriptor.version,
        ) ?? registrations.find((candidate) => candidate.definition.name === descriptor.name);
      if (registration === undefined) {
        throw new CrankError(
          "effect_handler_missing",
          `No installed-effect handler for ${descriptor.name}@${descriptor.version}`,
        );
      }
      const outcome = yield* registration.handler(descriptor.input, {
        sessionId: identity.sessionId,
        taskId: identity.taskId,
        pullId: attempt.pullId,
        attemptId: attempt.attemptId,
        cancellation: attempt.cancellation,
        resolver: descriptor.resolver,
      });
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
