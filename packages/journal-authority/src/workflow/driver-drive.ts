import { scoped, type Operation } from "effection";
import type {
  DurableEffectAuthorization,
  EffectDefinition,
  OperationOutcome,
  ProgramPlacementContextValue,
} from "@sweatpants/durable-effects";
import {
  CrankError,
  ProgramPeer,
  serializeDurableError,
  type AttachProgramRequest,
  type ProgramAttachment,
  type ProgramDriver,
  type ProgramRunResult,
  type ProgramShutdownReason,
  type ProgramStep,
} from "@sweatpants/durable-execution";
import type { Json } from "@sweatpants/foundation";

import type { JournalAuthorityContract } from "../authority-contract.ts";
import type {
  CancellationFrontier,
  CompleteTaskRequest,
  DurableCancellationState,
  RestoredFrontierProof,
} from "../authority-types.ts";

/** Explicit host composition for installed effects proposed by a remote driver. */
export interface ProgramDriverEffectHost {
  route(request: {
    readonly authorization: DurableEffectAuthorization;
    readonly definition: EffectDefinition<Json, Json, Json>;
    readonly placement: ProgramPlacementContextValue;
  }): Operation<"host" | "execution">;
  executeHost(
    authorization: DurableEffectAuthorization,
    placement: ProgramPlacementContextValue,
  ): Operation<OperationOutcome>;
  acknowledge?(request: {
    readonly authorization: DurableEffectAuthorization;
    readonly outcome: OperationOutcome;
  }): Operation<void>;
}

/**
 * Explicit model-context staging edge for a process-independent evaluator.
 * The returned input is installed into the otherwise unchanged `sample`
 * descriptor before Authority receives it.
 */
export type ProgramDriverSampleStager = (
  input: Json,
  attach: AttachProgramRequest,
) => Operation<Json>;

export interface DriveProgramDriverActivationRequest {
  readonly authority: JournalAuthorityContract;
  readonly driver: ProgramDriver;
  readonly attach: AttachProgramRequest;
  /** Capability minted by task opening; omitted on resumed attachments. */
  readonly initialProgramCapability?: string;
  /** Host-private owner for fenced restore-capable transports. */
  readonly activationOwnerId?: string;
  readonly effects?: ProgramDriverEffectHost;
  readonly stageSampleInput?: ProgramDriverSampleStager;
}

/**
 * Drives one process-independent ProgramDriver attachment against Authority.
 *
 * This operation deliberately owns no child recursion: an `invoke` reservation
 * parks and `driveWorkflowTree` allocates and activates the child. The driver
 * remains only an evaluator transport; Authority remains the sole durable
 * state owner.
 */
export function driveProgramDriverActivation(
  request: DriveProgramDriverActivationRequest,
): Operation<ProgramRunResult> {
  return scoped(function* () {
    const { authority, driver } = request;
    let attachment: ProgramAttachment | undefined;
    let shutdownReason: ProgramShutdownReason = "scope_exit";
    try {
      const acceptedInput = yield* authority.query({
        type: "task.input",
        sessionId: request.attach.sessionId,
        taskId: request.attach.taskId,
      });
      const acceptedAttach = { ...request.attach, input: acceptedInput };
      let step: ProgramStep;
      let frontierProof: RestoredFrontierProof | undefined;
      let programCapability = request.initialProgramCapability;
      let pullIndex = 0;

      if (request.activationOwnerId && driver.restore) {
        if (!driver.restoreContext) {
          throw new CrankError("placement_unavailable", "Driver restore context is missing");
        }
        const context = yield* driver.restoreContext(acceptedAttach);
        const prepared = yield* authority.command({
          type: "recovery.prepare-restore",
          request: {
            sessionId: acceptedAttach.sessionId,
            taskId: acceptedAttach.taskId,
            ownerId: request.activationOwnerId,
            activationEpoch: acceptedAttach.executionEpoch,
            releaseId: context.releaseId,
            sandboxSessionId: context.sandboxSessionId,
            replayDomain: context.replayDomain,
            frontierDomain: context.frontierDomain,
          },
        });
        pullIndex = prepared.replay.filter((entry) => entry.type === "operation").length;
        const restored = yield* ProgramPeer.operations.restore({
          attach: acceptedAttach,
          replay: prepared.replay,
          replayedThroughActionIndex: prepared.replayedThroughActionIndex,
          replayChainSeed: prepared.replayChainSeed,
          replayChainDigest: prepared.replayChainDigest,
        });
        if (
          restored.replayedThroughActionIndex !== prepared.replayedThroughActionIndex ||
          restored.replayChainDigest !== prepared.replayChainDigest
        ) {
          throw new CrankError("replay_diverged", "Restored replay evidence differs");
        }
        attachment = restored.attachment;
        step = restored.frontier;
        programCapability ??= (yield* bindAttachment(authority, acceptedAttach, attachment))
          .programCapability;
        const bound = yield* authority.command({
          type: "recovery.bind-frontier",
          request: {
            sessionId: acceptedAttach.sessionId,
            taskId: acceptedAttach.taskId,
            ownerId: request.activationOwnerId,
            activationEpoch: acceptedAttach.executionEpoch,
            restoreTicket: prepared.restoreTicket,
            frontierDigest: restored.frontierDigest,
          },
        });
        if (bound.status !== "bound") {
          throw new CrankError("restore_stale");
        }
        frontierProof = bound.proof;
      } else {
        attachment = yield* ProgramPeer.operations.attach(acceptedAttach);
        step = yield* ProgramPeer.operations.step(attachment, {
          type: "start",
          input: acceptedInput,
        });
      }

      programCapability ??= (yield* bindAttachment(authority, acceptedAttach, attachment))
        .programCapability;
      let cancellationInjected = false;

      while (true) {
        let cancellation = yield* authority.query({
          type: "task.cancellation-state",
          sessionId: acceptedAttach.sessionId,
          taskId: acceptedAttach.taskId,
        });
        if (
          !cancellationInjected &&
          isCancellationInProgress(cancellation) &&
          shouldInjectBeforeStep(step, cancellation.frontier)
        ) {
          if (cancellation.type !== "unwinding") {
            cancellation = yield* authority.command({
              type: "execution.begin-cancellation-unwind",
              request: {
                sessionId: acceptedAttach.sessionId,
                taskId: acceptedAttach.taskId,
                ...(frontierProof ? { restoredFrontier: { proof: frontierProof, step } } : {}),
              },
            });
            frontierProof = undefined;
          }
          if (step.type === "operation" || step.type === "emission") {
            const reason = "reason" in cancellation ? cancellation.reason : undefined;
            step = yield* ProgramPeer.operations.step(attachment, {
              type: "cancel",
              ...(reason === undefined ? {} : { reason }),
            });
            cancellationInjected = true;
            continue;
          }
        }

        if (step.type === "completed") {
          const unwound = yield* unwindCancellationIfNeeded(
            authority,
            acceptedAttach.sessionId,
            acceptedAttach.taskId,
            cancellation,
            frontierProof,
            step,
          );
          cancellation = unwound.cancellation;
          frontierProof = unwound.frontierProof;
          const closure = yield* completeTask(authority, {
            sessionId: acceptedAttach.sessionId,
            taskId: acceptedAttach.taskId,
            actionIndex: step.actionIndex,
            outcome: { status: "ok", value: step.value },
            programCapability,
            ...(frontierProof
              ? { restoredFrontier: frontierProof, restoredFrontierStep: step }
              : {}),
          });
          if (closure.status === "error") {
            shutdownReason = "failed";
            return { state: "failed", error: closure.error };
          }
          const cancelled = isCancellationInProgress(cancellation);
          shutdownReason = cancelled ? "cancelled" : "completed";
          return cancelled ? { state: "cancelled" } : { state: "completed", value: step.value };
        }

        if (step.type === "failed") {
          const cancelled =
            step.error.code === "program_cancelled" || isCancellationInProgress(cancellation);
          if (cancelled) {
            const unwound = yield* unwindCancellationIfNeeded(
              authority,
              acceptedAttach.sessionId,
              acceptedAttach.taskId,
              cancellation,
              frontierProof,
              step,
            );
            cancellation = unwound.cancellation;
            frontierProof = unwound.frontierProof;
          }
          try {
            yield* completeTask(authority, {
              sessionId: acceptedAttach.sessionId,
              taskId: acceptedAttach.taskId,
              actionIndex: step.actionIndex,
              outcome: cancelled ? { status: "cancelled" } : { status: "error", error: step.error },
              programCapability,
              ...(frontierProof
                ? { restoredFrontier: frontierProof, restoredFrontierStep: step }
                : {}),
            });
          } catch (error) {
            if (!(error instanceof CrankError) || error.code !== "history_not_exhausted") {
              throw error;
            }
            yield* authority.command({
              type: "execution.force-orphan",
              request: {
                sessionId: acceptedAttach.sessionId,
                taskId: acceptedAttach.taskId,
                reason: "replay_execution_failed",
              },
            });
          }
          shutdownReason = cancelled ? "cancelled" : "failed";
          return cancelled ? { state: "cancelled" } : { state: "failed", error: step.error };
        }

        if (step.type === "emission") {
          try {
            const receipt = yield* authority.command({
              type: "execution.append-emission",
              request: {
                sessionId: acceptedAttach.sessionId,
                taskId: acceptedAttach.taskId,
                actionIndex: step.actionIndex,
                descriptor: step.descriptor,
                programCapability,
                ...(frontierProof
                  ? { restoredFrontier: frontierProof, restoredFrontierStep: step }
                  : {}),
              },
            });
            if (receipt.restoredFrontierConsumed) {
              frontierProof = undefined;
            }
            step = yield* ProgramPeer.operations.step(attachment, {
              type: "ack_emission",
              actionIndex: step.actionIndex,
              offset: receipt.offset,
            });
          } catch (error) {
            if (!(error instanceof CrankError) || error.code !== "emission_quota_exceeded") {
              throw error;
            }
            const serialized = serializeDurableError(error);
            yield* completeTask(authority, {
              sessionId: acceptedAttach.sessionId,
              taskId: acceptedAttach.taskId,
              actionIndex: step.actionIndex,
              outcome: { status: "error", error: serialized },
              programCapability,
              ...(frontierProof
                ? { restoredFrontier: frontierProof, restoredFrontierStep: step }
                : {}),
            });
            shutdownReason = "failed";
            return { state: "failed", error: serialized };
          }
          continue;
        }

        const composed = yield* composeStep(step, acceptedAttach, request.stageSampleInput);
        const reservation = yield* authority.command({
          type: "execution.reserve-pull",
          request: {
            sessionId: acceptedAttach.sessionId,
            turnId: turnIdFor(acceptedAttach.taskId),
            taskId: acceptedAttach.taskId,
            actionIndex: step.actionIndex,
            pullIndex,
            descriptor: composed.descriptor,
            programCapability,
            ...(frontierProof
              ? { restoredFrontier: frontierProof, restoredFrontierStep: composed }
              : {}),
          },
        });
        if (reservation.restoredFrontierConsumed) {
          frontierProof = undefined;
        }

        if (reservation.status === "resolved") {
          pullIndex += 1;
          if (
            reservation.outcome.status === "cancelled" &&
            isCancellationInProgress(cancellation) &&
            cancellation.frontier.pullId === reservation.receipt.pullId
          ) {
            if (cancellation.type !== "unwinding") {
              yield* authority.command({
                type: "execution.begin-cancellation-unwind",
                request: {
                  sessionId: acceptedAttach.sessionId,
                  taskId: acceptedAttach.taskId,
                  ...(frontierProof ? { restoredFrontier: { proof: frontierProof, step } } : {}),
                },
              });
              frontierProof = undefined;
            }
            cancellationInjected = true;
          }
          step = yield* ProgramPeer.operations.step(attachment, {
            type: "resume",
            actionIndex: step.actionIndex,
            outcome: reservation.outcome,
            receipt: reservation.receipt,
            replayed: true,
          });
          continue;
        }

        if (reservation.status === "authorized" && composed.descriptor.kind === "record") {
          const authorized = yield* ProgramPeer.operations.step(attachment, {
            type: "authorize",
            actionIndex: step.actionIndex,
            pullId: reservation.pullId,
            attemptId: reservation.attemptId,
            resolutionCapability: reservation.resolutionCapability,
            descriptor: reservation.descriptor,
          });
          assertAuthorizedStep(authorized, step.actionIndex, "recorded work");
          let resolution = yield* authority.command({
            type: "execution.resolve-pull",
            request: {
              capability: reservation.resolutionCapability,
              audience: "program-execution",
              outcome: authorized.authorizedOutcome,
            },
          });
          if (resolution.status === "rejected" && resolution.code === "payload_too_large") {
            resolution = yield* authority.command({
              type: "execution.resolve-pull",
              request: {
                capability: reservation.resolutionCapability,
                audience: "program-execution",
                outcome: {
                  status: "error",
                  error: serializeDurableError(
                    new CrankError("record_value_too_large", "Recorded value exceeds inline limit"),
                  ),
                },
              },
            });
          }
          if (resolution.status === "rejected") {
            throw new CrankError(resolution.code);
          }
          const resumed = yield* resumeResolvedOperation(
            authority,
            attachment,
            acceptedAttach,
            step,
            pullIndex,
            programCapability,
            request.stageSampleInput,
            true,
            "Resolved recording was not replayable",
          );
          step = resumed.step;
          pullIndex = resumed.pullIndex;
          continue;
        }

        if (reservation.status === "authorized" && composed.descriptor.kind === "effect") {
          if (!request.effects) {
            shutdownReason = "parked";
            return { state: "parked", pullId: reservation.pullId, reason: "external_effect" };
          }
          if (reservation.descriptor.kind !== "effect" || !reservation.effectContractDigest) {
            throw new CrankError("runtime_error", "Installed effect authorization is malformed");
          }
          const definition = reservation.effectDefinition;
          if (!definition) {
            throw new CrankError("invalid_manifest", "Installed effect definition is unavailable");
          }
          const journal = yield* authority.query({ type: "authority.identity" });
          const authorization: DurableEffectAuthorization = {
            sessionId: acceptedAttach.sessionId,
            taskId: acceptedAttach.taskId,
            pullId: reservation.pullId,
            attemptId: reservation.attemptId,
            descriptor: reservation.descriptor,
            effectContractDigest: reservation.effectContractDigest,
            resolutionCapability: reservation.resolutionCapability,
            resolver: composed.descriptor.resolver,
          };
          const placement: ProgramPlacementContextValue = {
            journal,
            program: acceptedAttach.program,
            route: acceptedAttach.route,
            driverKind: routeDriverKind(acceptedAttach.route),
          };
          const route = yield* request.effects.route({
            authorization,
            definition,
            placement,
          });
          let outcome: OperationOutcome;
          if (route === "execution") {
            const authorized = yield* ProgramPeer.operations.step(attachment, {
              type: "authorize",
              actionIndex: step.actionIndex,
              pullId: reservation.pullId,
              attemptId: reservation.attemptId,
              resolutionCapability: reservation.resolutionCapability,
              descriptor: reservation.descriptor,
              effectContractDigest: reservation.effectContractDigest,
              placement,
            });
            assertAuthorizedStep(authorized, step.actionIndex, "execution effect");
            outcome = authorized.authorizedOutcome;
          } else {
            try {
              outcome = yield* request.effects.executeHost(authorization, placement);
            } catch (error) {
              outcome = { status: "error", error: serializeDurableError(error) };
            }
          }
          const resolution = yield* authority.command({
            type: "execution.resolve-pull",
            request: {
              capability: reservation.resolutionCapability,
              audience: composed.descriptor.resolver.audience,
              outcome,
            },
          });
          if (resolution.status === "rejected") {
            throw new CrankError(resolution.code);
          }
          if (request.effects.acknowledge) {
            try {
              yield* request.effects.acknowledge({ authorization, outcome });
            } catch {
              // Journal acceptance is authoritative; cleanup remains retryable.
            }
          }
          const resumed = yield* resumeResolvedOperation(
            authority,
            attachment,
            acceptedAttach,
            step,
            pullIndex,
            programCapability,
            request.stageSampleInput,
            route === "execution",
            "Resolved effect was not replayable",
          );
          step = resumed.step;
          pullIndex = resumed.pullIndex;
          continue;
        }

        shutdownReason = "parked";
        return {
          state: "parked",
          pullId: reservation.pullId,
          reason: reservation.status === "pending" ? reservation.reason : "external_effect",
        };
      }
    } catch (error) {
      if (
        error instanceof CrankError &&
        (error.code === "nondeterminism_detected" ||
          error.code === "history_not_exhausted" ||
          error.code === "replay_diverged")
      ) {
        yield* request.authority.command({
          type: "execution.force-orphan",
          request: {
            sessionId: request.attach.sessionId,
            taskId: request.attach.taskId,
            reason: "replay_diverged",
          },
        });
        if (error.code === "history_not_exhausted") {
          throw new CrankError(
            "replay_diverged",
            "Accepted replay history was not exhausted",
            undefined,
            { cause: error },
          );
        }
      }
      throw error;
    } finally {
      if (attachment) {
        yield* ProgramPeer.operations.shutdown(attachment, shutdownReason);
      }
    }
  });
}

function bindAttachment(
  authority: JournalAuthorityContract,
  attach: AttachProgramRequest,
  attachment: ProgramAttachment,
) {
  return authority.command({
    type: "execution.bind-attachment",
    request: {
      sessionId: attach.sessionId,
      taskId: attach.taskId,
      attachmentId: attachment.attachmentId,
      executionEpoch: attach.executionEpoch,
    },
  });
}

function* composeStep(
  step: Extract<ProgramStep, { type: "operation" }>,
  attach: AttachProgramRequest,
  stage: ProgramDriverSampleStager | undefined,
): Operation<Extract<ProgramStep, { type: "operation" }>> {
  if (!stage || step.descriptor.kind !== "sample") {
    return step;
  }
  return {
    ...step,
    descriptor: { ...step.descriptor, input: yield* stage(step.descriptor.input, attach) },
  };
}

function* resumeResolvedOperation(
  authority: JournalAuthorityContract,
  attachment: ProgramAttachment,
  attach: AttachProgramRequest,
  step: Extract<ProgramStep, { type: "operation" }>,
  pullIndex: number,
  programCapability: string,
  compose: ProgramDriverSampleStager | undefined,
  attemptedInDriver: boolean,
  replayError: string,
): Operation<{ step: ProgramStep; pullIndex: number }> {
  const composed = yield* composeStep(step, attach, compose);
  const replayed = yield* authority.command({
    type: "execution.reserve-pull",
    request: {
      sessionId: attach.sessionId,
      turnId: turnIdFor(attach.taskId),
      taskId: attach.taskId,
      actionIndex: step.actionIndex,
      pullIndex,
      descriptor: composed.descriptor,
      programCapability,
    },
  });
  if (replayed.status !== "resolved") {
    throw new CrankError("runtime_error", replayError);
  }
  return {
    step: yield* ProgramPeer.operations.step(attachment, {
      type: "resume",
      actionIndex: step.actionIndex,
      outcome: replayed.outcome,
      receipt: replayed.receipt,
      replayed: !attemptedInDriver,
    }),
    pullIndex: pullIndex + 1,
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

function* completeTask(
  authority: JournalAuthorityContract,
  request: CompleteTaskRequest,
): Operation<{ status: "ok" } | { status: "error"; error: { code: string; message: string } }> {
  const result = yield* authority.command({ type: "execution.complete-task", request });
  if (result.status !== "rejected") {
    return request.outcome.status === "error"
      ? { status: "error", error: request.outcome.error }
      : { status: "ok" };
  }
  const error = { code: result.code, message: result.message };
  const retry = yield* authority.command({
    type: "execution.complete-task",
    request: { ...request, outcome: { status: "error", error } },
  });
  if (retry.status === "rejected") {
    throw new CrankError(retry.code, retry.message);
  }
  return { status: "error", error };
}

function routeDriverKind(route: AttachProgramRequest["route"]): string {
  if (route === null || typeof route !== "object" || Array.isArray(route)) {
    return "program";
  }
  const value = route["driverKind"] ?? route["kind"];
  return typeof value === "string" && value ? value : "program";
}

function turnIdFor(taskId: string): string {
  const slash = taskId.indexOf("/");
  return slash === -1 ? "turn-0" : taskId.slice(0, slash);
}

function isCancellationInProgress(
  state: DurableCancellationState,
): state is Extract<
  DurableCancellationState,
  { type: "requested" | "settling_pull" | "cancelling_children" | "unwinding" }
> {
  return (
    state.type === "requested" ||
    state.type === "settling_pull" ||
    state.type === "cancelling_children" ||
    state.type === "unwinding"
  );
}

function* unwindCancellationIfNeeded(
  authority: JournalAuthorityContract,
  sessionId: string,
  taskId: string,
  cancellation: DurableCancellationState,
  frontierProof: RestoredFrontierProof | undefined,
  step: ProgramStep,
): Operation<{
  cancellation: DurableCancellationState;
  frontierProof: RestoredFrontierProof | undefined;
}> {
  if (isCancellationInProgress(cancellation) && cancellation.type !== "unwinding") {
    return {
      cancellation: yield* authority.command({
        type: "execution.begin-cancellation-unwind",
        request: {
          sessionId,
          taskId,
          ...(frontierProof ? { restoredFrontier: { proof: frontierProof, step } } : {}),
        },
      }),
      frontierProof: undefined,
    };
  }
  return { cancellation, frontierProof };
}

function shouldInjectBeforeStep(step: ProgramStep, frontier: CancellationFrontier): boolean {
  if (step.type === "completed" || step.type === "failed") {
    return step.actionIndex >= frontier.actionIndex;
  }
  return frontier.pullId === undefined
    ? step.actionIndex >= frontier.actionIndex
    : step.actionIndex > frontier.actionIndex;
}
