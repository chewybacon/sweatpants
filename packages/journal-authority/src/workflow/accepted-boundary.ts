import type { Operation } from "effection";
import type { Handler } from "@sweatpants/foundation/computation";
import type {
  DurableEffectAuthorization,
  OperationOutcome,
  ProgramPlacementContextValue,
} from "@sweatpants/durable-effects";
import {
  CrankError,
  ProgramPeer,
  serializeDurableError,
  type AdvancementResult,
  type AttachProgramRequest,
  type CaughtUpLeaf,
  type ProgramStep,
  type ProgramCommand,
  type ReplayItem,
  type ResolutionReceipt,
} from "@sweatpants/durable-execution";
import {
  RetryableEffectAcknowledgement,
  type AdvancementServices,
  type EffectRouter,
  type JournalSamplingService,
} from "./advancement-ports.ts";
import { ActivationFailure, type FailureSite } from "./activation-lifetime.ts";
import type { ExecutionComposition } from "./execution-composition.ts";
import type {
  AcceptedExtensionObservation,
  JournalAuthorityContract,
} from "../contract/authority-contract.ts";
import { acceptedPrefixAnchor, validateAcceptedExtension } from "./accepted-history.ts";

type Yielded =
  ReturnType<Operation<unknown>[typeof Symbol.iterator]> extends Iterator<infer Y, unknown, unknown>
    ? Y
    : never;
type Boundary = Extract<ProgramStep, { type: "operation" | "emission" }>;
export type AcceptedReply =
  | {
      kind: "operation";
      actionIndex: number;
      outcome: OperationOutcome;
      receipt: Extract<ReplayItem["replay"][number], { type: "operation" }>["receipt"];
      replayed: boolean;
    }
  | { kind: "emission"; actionIndex: number; offset: string };
export type AcceptedBatch = {
  kind: "suffix";
  extension: AcceptedExtensionObservation;
  settledActionIndex: number;
  attemptedInDriver: boolean;
};
type Decision =
  | { kind: "emission"; reply: AcceptedReply }
  | AcceptedBatch
  | { kind: "parked"; result: Extract<AdvancementResult, { state: "parked" }> };
export type AcceptanceHandler = Handler<Boundary, Yielded, Decision>;
type Attempt =
  | { kind: "execution"; command: Extract<ProgramCommand, { type: "authorize" }> }
  | {
      kind: "host";
      effects: EffectRouter;
      authorization: DurableEffectAuthorization;
      placement: ProgramPlacementContextValue;
    };

function createAttemptHandler(
  attachment: CaughtUpLeaf["restored"]["attachment"],
): Handler<Attempt, Yielded, OperationOutcome> {
  return function* attempt(request) {
    if (request.kind === "execution") {
      const authorized = yield* ProgramPeer.operations.step(attachment, request.command);
      assertAuthorizedStep(authorized, request.command.actionIndex, "authorized work");
      return authorized.authorizedOutcome;
    }
    try {
      return yield* request.effects.executeHost(request.authorization, request.placement);
    } catch (error) {
      return { status: "error", error: serializeDurableError(error) };
    }
  };
}

/** One boundary's acceptance, never computation advancement or binding. */
export function createAcceptanceHandler(request: {
  caughtUp: CaughtUpLeaf;
  execution: ExecutionComposition;
  services: AdvancementServices;
  authority: JournalAuthorityContract;
  onSettled(): void;
}): AcceptanceHandler {
  const { caughtUp, execution } = request;
  let site: FailureSite = "live";
  const attempt = createAttemptHandler(caughtUp.restored.attachment);
  const attach: AttachProgramRequest = {
    sessionId: execution.mandate.address.sessionId,
    taskId: execution.mandate.address.taskId,
    program: execution.mandate.program,
    input: caughtUp.item.input,
    route: caughtUp.item.route,
    executionEpoch: execution.mandate.lease.epoch,
    /* CONDITIONAL-SPREAD: Omit absent affinity from journal commands, decisions, and replay records; explicit undefined is not a portable JSON value. */
    ...(execution.mandate.placement.sandbox.mode === "reuse"
      ? { affinity: execution.mandate.placement.sandbox.affinity }
      : {}),
  };

  function* accept(
    step: Boundary,
  ): Operation<
    Exclude<Decision, AcceptedBatch> | { attemptedInDriver: boolean; receipt: ResolutionReceipt }
  > {
    if (step.type === "emission") {
      const receipt = yield* execution.emit(step.descriptor);
      return {
        kind: "emission",
        reply: { kind: "emission", actionIndex: step.actionIndex, offset: receipt.offset },
      };
    }
    const composed = yield* composeStep(step, attach, request.services.stageSampleInput);
    const reservation = yield* execution.reserve(composed.descriptor);
    if (reservation.status === "pending") {
      return {
        kind: "parked",
        result: {
          state: "parked",
          pullId: reservation.pullId,
          reason: reservation.reason,
          slots: [
            {
              taskId: execution.mandate.address.taskId,
              pullId: reservation.pullId,
              reason: reservation.reason,
            },
          ],
        },
      };
    }

    if (composed.descriptor.kind === "record") {
      let committedOutcome = yield* attempt({
        kind: "execution",
        command: {
          type: "authorize",
          actionIndex: step.actionIndex,
          pullId: reservation.pullId,
          attemptId: reservation.attemptId,
          resolutionCapability: reservation.resolutionCapability,
          descriptor: reservation.descriptor,
        },
      });
      let resolution = yield* execution.resolve({
        capability: reservation.resolutionCapability,
        audience: "program-execution",
        outcome: committedOutcome,
      });
      if (resolution.status === "rejected" && resolution.code === "payload_too_large") {
        committedOutcome = {
          status: "error",
          error: serializeDurableError(
            new CrankError("record_value_too_large", "Recorded value exceeds inline limit"),
          ),
        };
        resolution = yield* execution.resolve({
          capability: reservation.resolutionCapability,
          audience: "program-execution",
          outcome: committedOutcome,
        });
      }
      if (resolution.status === "rejected") {
        throw new CrankError(resolution.code);
      }
      request.onSettled();
      return { attemptedInDriver: true, receipt: resolution.receipt };
    }

    if (composed.descriptor.kind === "effect") {
      if (!request.services.effects) {
        return {
          kind: "parked",
          result: {
            state: "parked",
            pullId: reservation.pullId,
            reason: "external_effect",
            slots: [
              {
                taskId: execution.mandate.address.taskId,
                pullId: reservation.pullId,
                reason: "external_effect",
              },
            ],
          },
        };
      }
      if (reservation.descriptor.kind !== "effect" || !reservation.effectContractDigest) {
        throw new CrankError("runtime_error", "Installed effect authorization is malformed");
      }
      const definition = reservation.effectDefinition;
      if (!definition) {
        throw new CrankError("invalid_manifest", "Effect definition unavailable");
      }
      const journal = yield* execution.identity();
      const authorization: DurableEffectAuthorization = {
        sessionId: execution.mandate.address.sessionId,
        taskId: execution.mandate.address.taskId,
        pullId: reservation.pullId,
        attemptId: reservation.attemptId,
        descriptor: reservation.descriptor,
        effectContractDigest: reservation.effectContractDigest,
        resolutionCapability: reservation.resolutionCapability,
        resolver: composed.descriptor.resolver,
      };
      const placement: ProgramPlacementContextValue = {
        journal,
        program: execution.mandate.program,
        route: caughtUp.item.route,
        driverKind: execution.mandate.placement.route.driverKind,
      };
      const route = yield* request.services.effects.route({ authorization, definition, placement });
      const outcome = yield* attempt(
        route === "execution"
          ? {
              kind: "execution",
              command: {
                type: "authorize",
                actionIndex: step.actionIndex,
                pullId: reservation.pullId,
                attemptId: reservation.attemptId,
                resolutionCapability: reservation.resolutionCapability,
                descriptor: reservation.descriptor,
                effectContractDigest: reservation.effectContractDigest,
                placement,
              },
            }
          : { kind: "host", effects: request.services.effects, authorization, placement },
      );
      const resolution = yield* execution.resolve({
        capability: reservation.resolutionCapability,
        audience: composed.descriptor.resolver.audience,
        outcome,
      });
      if (resolution.status === "rejected") {
        throw new CrankError(resolution.code);
      }
      request.onSettled();
      site = "acknowledgement";
      if (request.services.effects.acknowledge) {
        try {
          yield* request.services.effects.acknowledge({ authorization, outcome });
        } catch (error) {
          if (!(error instanceof RetryableEffectAcknowledgement)) {
            throw error;
          }
          // The port explicitly classified this post-commit cleanup as retryable.
        }
      }
      return { attemptedInDriver: route === "execution", receipt: resolution.receipt };
    }

    throw new CrankError("runtime_error", "Authority authorized a non-executable operation");
  }
  return function* acceptBoundary(step) {
    site = "live";
    try {
      const accepted = yield* accept(step);
      if ("kind" in accepted) {
        return accepted;
      }
      const settled = { actionIndex: step.actionIndex, receipt: accepted.receipt };
      site = "observation";
      const extension = yield* request.authority.query({
        type: "task.accepted-extension",
        request: { anchor: acceptedPrefixAnchor(caughtUp), settled },
      });
      site = "validation";
      validateAcceptedExtension(caughtUp, extension, settled);
      return {
        kind: "suffix",
        extension,
        settledActionIndex: step.actionIndex,
        attemptedInDriver: accepted.attemptedInDriver,
      };
    } catch (error) {
      throw new ActivationFailure(error, site);
    }
  };
}

/** The only accepted reply transport; deliberately has no loop or authority. */
export function* deliverAccepted(
  attachment: CaughtUpLeaf["restored"]["attachment"],
  reply: AcceptedReply,
): Operation<ProgramStep> {
  return yield* ProgramPeer.operations.step(
    attachment,
    reply.kind === "operation"
      ? {
          type: "resume",
          actionIndex: reply.actionIndex,
          outcome: reply.outcome,
          receipt: reply.receipt,
          replayed: reply.replayed,
        }
      : { type: "ack_emission", actionIndex: reply.actionIndex, offset: reply.offset },
  );
}

function* composeStep(
  step: Extract<ProgramStep, { type: "operation" }>,
  attach: AttachProgramRequest,
  stage: JournalSamplingService | undefined,
): Operation<Extract<ProgramStep, { type: "operation" }>> {
  if (!stage || step.descriptor.kind !== "sample") {
    return step;
  }
  return {
    ...step,
    descriptor: { ...step.descriptor, input: yield* stage(step.descriptor.input, attach) },
  };
}

function assertAuthorizedStep(
  step: ProgramStep,
  actionIndex: number,
  subject: string,
): asserts step is Extract<ProgramStep, { type: "operation" }> & {
  readonly authorizedOutcome: OperationOutcome;
} {
  if (step.type !== "operation" || step.actionIndex !== actionIndex || !step.authorizedOutcome) {
    throw new CrankError("program_protocol_error", `Driver did not settle ${subject}`);
  }
}
