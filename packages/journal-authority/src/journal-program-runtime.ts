import { scoped, useScope, type Operation } from "effection";
import type { DurableEffectAuthorization, OperationOutcome } from "@sweatpants/durable-effects";

import { serializeDurableError } from "@sweatpants/durable-execution";
import { canonicalSnapshot } from "@sweatpants/foundation";
import { CrankError } from "@sweatpants/durable-execution";
import { DurableEffects, DurableEffectRouting } from "@sweatpants/durable-effects/runtime";
import {
  DurableEffectInputPreparationContext,
  ProgramDriverRegistryContext,
  ProgramExecutionScopeContext,
  ProgramPeer,
  ProgramRouteResolver,
  ProgramRuntime,
  ProgramRuntimeDriverContext,
  type ProgramDriverRegistry,
  type ProgramRuntimeDriver,
} from "@sweatpants/durable-execution";
import {
  DurableEffectOutcomeAcknowledgerContext,
  ProgramPlacementContext,
} from "@sweatpants/durable-effects";
import type {
  AppendEmissionRequest,
  CancellationFrontier,
  CompleteTaskRequest,
  DurableCancellationState,
  EmissionReceipt,
  ReserveOperationRequest,
  ReserveOperationResult,
  RestoredFrontierProof,
  ResolveOperationRequest,
  ResolveOperationResult,
  TaskCloseReceipt,
} from "./authority-types.ts";
import type { JournalAuthorityContract } from "./authority-contract.ts";
import { JournalAuthorityPort } from "./authority-ports.ts";
import type {
  ProgramAttachment,
  ProgramDriver,
  ProgramRunRequest,
  ProgramRoute,
  ProgramRunResult,
  ProgramShutdownReason,
  ProgramStep,
} from "@sweatpants/durable-execution";

function* prepareOperationStep(
  step: Extract<ProgramStep, { type: "operation" }>,
): Operation<Extract<ProgramStep, { type: "operation" }>> {
  if (step.descriptor.kind !== "effect") return step;
  const prepare = yield* DurableEffectInputPreparationContext.get();
  if (!prepare) return step;
  const descriptor = step.descriptor;
  return {
    ...step,
    descriptor: {
      ...descriptor,
      input: canonicalSnapshot(
        yield* prepare({
          name: descriptor.name,
          version: descriptor.version,
          input: descriptor.input,
          resolver: descriptor.resolver,
        }),
      ).value,
    },
  };
}

/** @internal Transitional installer used while repository callers move to composition options. */
export function* installJournalProgramRuntime(): Operation<void> {
  yield* ProgramRuntimeDriverContext.set(legacyProgramRuntimeDriver);
}

/** @internal Test-only installer for a precomposed command/query authority. */
export function* installAuthorityTestScope(authority: JournalAuthorityContract): Operation<void> {
  yield* JournalAuthorityPort.installDriver(authority);
  yield* installJournalProgramRuntime();
}

/** Runs `body` with `authority` installed in a child scope. */
export function withAuthorityTestScope<T>(
  authority: JournalAuthorityContract,
  body: () => Operation<T>,
): Operation<T> {
  return scoped(function* () {
    yield* installAuthorityTestScope(authority);
    return yield* body();
  });
}
/**
 * Journal authority bound to the calling scope.
 *
 * Callers that hand work to a detached task must resolve this before handing
 * off, so dispatch stays pinned to the scope that owns the authority.
 */
function* useJournalAuthority(): Operation<JournalAuthorityContract> {
  return JournalAuthorityPort.bind(yield* useScope());
}

/**
 * Native authority API mediating durable transitions.
 *
 * This is the port's own api, so there is no separate facade that could drift
 * from the service contract.
 */
const JournalAuthority = JournalAuthorityPort.api;

function reserveCommand(request: ReserveOperationRequest): Operation<ReserveOperationResult> {
  return JournalAuthority.operations.command({ type: "execution.reserve-pull", request });
}

function resolveCommand(request: ResolveOperationRequest): Operation<ResolveOperationResult> {
  return JournalAuthority.operations.command({ type: "execution.resolve-pull", request });
}

function emitCommand(request: AppendEmissionRequest): Operation<EmissionReceipt> {
  return JournalAuthority.operations.command({ type: "execution.append-emission", request });
}

interface TaskClosure {
  readonly receipt: TaskCloseReceipt;
  /** The outcome the authority actually closed the task with. */
  readonly outcome: OperationOutcome;
}

function* completeCommand(request: CompleteTaskRequest): Operation<TaskClosure> {
  const result = yield* JournalAuthority.operations.command({
    type: "execution.complete-task",
    request,
  });
  if (result.status === "rejected") {
    // Program-authored values the authority refuses surface as ordinary
    // program failures: close through the standard error envelope so the
    // journal records TaskClosed{error} exactly like a thrown body.
    const error = { code: result.code, message: result.message };
    const retry = yield* JournalAuthority.operations.command({
      type: "execution.complete-task",
      request: { ...request, outcome: { status: "error", error } },
    });
    if (retry.status === "rejected") throw new CrankError(retry.code, retry.message);
    return { receipt: retry.receipt, outcome: { status: "error", error } };
  }
  return { receipt: result.receipt, outcome: request.outcome };
}

/** Resolves the durable-effects-owned dispatch outcome through Journal Authority. */
function* executeDurableEffectAuthorization(
  authorization: DurableEffectAuthorization,
): Operation<ResolveOperationResult> {
  let outcome: OperationOutcome;
  try {
    outcome = yield* DurableEffects.operations.execute(authorization);
  } catch (error) {
    outcome = { status: "error", error: serializeDurableError(error) };
  }
  const resolution = yield* resolveCommand({
    capability: authorization.resolutionCapability,
    audience: authorization.resolver.audience,
    outcome,
  });
  if (resolution.status !== "rejected") {
    yield* acknowledgeDurableEffect(authorization, outcome);
  }
  return resolution;
}

function* resumeResolvedOperation(
  authority: JournalAuthorityContract,
  attachment: ProgramAttachment,
  request: ProgramRunRequest,
  step: Extract<ProgramStep, { type: "operation" }>,
  pullIndex: number,
  programCapability: string,
  replayError: string,
): Operation<{ step: ProgramStep; pullIndex: number }> {
  const preparedStep = yield* prepareOperationStep(step);
  const replayed = yield* authority.command({
    type: "execution.reserve-pull",
    request: {
      sessionId: request.attach.sessionId,
      turnId: turnIdFor(request.attach.taskId),
      taskId: request.attach.taskId,
      actionIndex: step.actionIndex,
      pullIndex,
      descriptor: preparedStep.descriptor,
      programCapability,
    },
  });
  if (replayed.status !== "resolved") {
    throw new CrankError("runtime_error", replayError);
  }
  const nextStep = yield* ProgramPeer.operations.step(attachment, {
    type: "resume",
    actionIndex: step.actionIndex,
    outcome: replayed.outcome,
    receipt: replayed.receipt,
    replayed: false,
  });
  return { step: nextStep, pullIndex: pullIndex + 1 };
}

function* acknowledgeDurableEffect(
  authorization: DurableEffectAuthorization,
  outcome: OperationOutcome,
): Operation<void> {
  const acknowledge = yield* DurableEffectOutcomeAcknowledgerContext.get();
  if (!acknowledge) {
    return;
  }
  try {
    yield* acknowledge({
      effect: {
        name: authorization.descriptor.name,
        version: authorization.descriptor.version,
      },
      sessionId: authorization.sessionId,
      taskId: authorization.taskId,
      pullId: authorization.pullId,
      attemptId: authorization.attemptId,
      outcomeDigest: canonicalSnapshot(outcome).sha,
    });
  } catch {
    // Journal acceptance is authoritative; cleanup remains retryable.
  }
}

/** Structured runtime API that drives programs and their child topology to a durable boundary. */
const legacyProgramRuntimeDriver: ProgramRuntimeDriver = {
  *run(request: ProgramRunRequest): Operation<ProgramRunResult> {
    const executionScope = yield* useScope();
    yield* ProgramExecutionScopeContext.set(executionScope);
    let attachment: ProgramAttachment | undefined;
    let authority: JournalAuthorityContract | undefined;
    let shutdownReason: ProgramShutdownReason = "scope_exit";
    try {
      authority = yield* useJournalAuthority();
      const acceptedInput = yield* authority.query({
        type: "task.input",
        sessionId: request.attach.sessionId,
        taskId: request.attach.taskId,
      });
      const acceptedAttach = { ...request.attach, input: acceptedInput };
      const driver = yield* driverFor(driverKind(acceptedAttach.route));
      let step: ProgramStep;
      let frontierProof: RestoredFrontierProof | undefined;
      let programCapability = request.programCapability;
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
        programCapability ??= (yield* authority.command({
          type: "execution.bind-attachment",
          request: {
            sessionId: request.attach.sessionId,
            taskId: request.attach.taskId,
            attachmentId: attachment.attachmentId,
            executionEpoch: request.attach.executionEpoch,
          },
        })).programCapability;
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
      programCapability ??= (yield* authority.command({
        type: "execution.bind-attachment",
        request: {
          sessionId: request.attach.sessionId,
          taskId: request.attach.taskId,
          attachmentId: attachment.attachmentId,
          executionEpoch: request.attach.executionEpoch,
        },
      })).programCapability;
      let cancellationInjected = false;
      while (true) {
        let cancellation = yield* authority.query({
          type: "task.cancellation-state",
          sessionId: request.attach.sessionId,
          taskId: request.attach.taskId,
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
                sessionId: request.attach.sessionId,
                taskId: request.attach.taskId,
                ...(frontierProof ? { restoredFrontier: { proof: frontierProof, step } } : {}),
              },
            });
            frontierProof = undefined;
          }
          if (step.type === "operation" || step.type === "emission") {
            const cancellationReason = "reason" in cancellation ? cancellation.reason : undefined;
            step = yield* ProgramPeer.operations.step(attachment, {
              type: "cancel",
              ...(cancellationReason !== undefined ? { reason: cancellationReason } : {}),
            });
            cancellationInjected = true;
            continue;
          }
        }
        if (step.type === "completed") {
          const unwound = yield* unwindCancellationIfNeeded(
            authority,
            request.attach.sessionId,
            request.attach.taskId,
            cancellation,
            frontierProof,
            step,
          );
          cancellation = unwound.cancellation;
          frontierProof = unwound.frontierProof;
          const proof = frontierProof;
          const closure = yield* completeCommand({
            sessionId: request.attach.sessionId,
            taskId: request.attach.taskId,
            actionIndex: step.actionIndex,
            outcome: { status: "ok", value: step.value },
            programCapability,
            ...(proof ? { restoredFrontier: proof, restoredFrontierStep: step } : {}),
          });
          if (closure.outcome.status === "error") {
            // Authority refused the program's value; the task closed as a
            // failure even though the terminal step reported success.
            shutdownReason = "failed";
            return { state: "failed", error: closure.outcome.error };
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
              request.attach.sessionId,
              request.attach.taskId,
              cancellation,
              frontierProof,
              step,
            );
            cancellation = unwound.cancellation;
            frontierProof = unwound.frontierProof;
          }
          const proof = frontierProof;
          try {
            yield* completeCommand({
              sessionId: request.attach.sessionId,
              taskId: request.attach.taskId,
              actionIndex: step.actionIndex,
              outcome: cancelled ? { status: "cancelled" } : { status: "error", error: step.error },
              programCapability,
              ...(proof ? { restoredFrontier: proof, restoredFrontierStep: step } : {}),
            });
          } catch (error) {
            if (!(error instanceof CrankError) || error.code !== "history_not_exhausted") {
              throw error;
            }
            // Ordinary Effection operations are intentionally rerun during
            // reconstruction. If one now fails before an accepted frontier,
            // fence the unreconstructable task and propagate its original error.
            yield* authority.command({
              type: "execution.force-orphan",
              request: {
                sessionId: request.attach.sessionId,
                taskId: request.attach.taskId,
                reason: "replay_execution_failed",
              },
            });
          }
          shutdownReason = cancelled ? "cancelled" : "failed";
          return cancelled ? { state: "cancelled" } : { state: "failed", error: step.error };
        }
        if (step.type === "emission") {
          const proof = frontierProof;
          let receipt: EmissionReceipt;
          try {
            receipt = yield* emitCommand({
              sessionId: request.attach.sessionId,
              taskId: request.attach.taskId,
              actionIndex: step.actionIndex,
              descriptor: step.descriptor,
              programCapability,
              ...(proof ? { restoredFrontier: proof, restoredFrontierStep: step } : {}),
            });
          } catch (error) {
            if (!(error instanceof CrankError) || error.code !== "emission_quota_exceeded") {
              throw error;
            }
            const serialized = serializeDurableError(error);
            yield* completeCommand({
              sessionId: request.attach.sessionId,
              taskId: request.attach.taskId,
              actionIndex: step.actionIndex,
              outcome: { status: "error", error: serialized },
              programCapability,
              ...(proof ? { restoredFrontier: proof, restoredFrontierStep: step } : {}),
            });
            shutdownReason = "failed";
            return { state: "failed", error: serialized };
          }
          if (receipt.restoredFrontierConsumed) {
            frontierProof = undefined;
          }
          step = yield* ProgramPeer.operations.step(attachment, {
            type: "ack_emission",
            actionIndex: step.actionIndex,
            offset: receipt.offset,
          });
          continue;
        }
        const proof = frontierProof;
        const preparedStep = yield* prepareOperationStep(step);
        const descriptor = preparedStep.descriptor;
        const reservation = yield* reserveCommand({
          sessionId: request.attach.sessionId,
          turnId: turnIdFor(request.attach.taskId),
          taskId: request.attach.taskId,
          actionIndex: step.actionIndex,
          pullIndex,
          descriptor,
          programCapability,
          ...(proof ? { restoredFrontier: proof, restoredFrontierStep: preparedStep } : {}),
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
                  sessionId: request.attach.sessionId,
                  taskId: request.attach.taskId,
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
        if (reservation.status === "pending" && descriptor.kind === "invoke") {
          const child = descriptor.child;
          const routeResolver = yield* ProgramRouteResolver.use();
          const childRoute = yield* routeResolver.resolve({
            program: child,
            parentRoute: request.attach.route,
          });
          const manifest = yield* ProgramPeer.operations.manifest(childRoute, child);
          const childTask = yield* authority.command({
            type: "execution.ensure-child",
            request: {
              sessionId: request.attach.sessionId,
              turnId: turnIdFor(request.attach.taskId),
              parentTaskId: request.attach.taskId,
              parentPullId: reservation.pullId,
              child,
              manifest,
              executionEpoch: request.attach.executionEpoch,
              audience: "program-runtime",
              route: childRoute,
            },
          });
          let childOutcome = childTask.outcome;
          if (!childOutcome) {
            const childRun = yield* ProgramRuntime.operations.run({
              attach: {
                sessionId: request.attach.sessionId,
                taskId: childTask.taskId,
                program: child,
                input: child.input,
                route: childRoute,
                executionEpoch: request.attach.executionEpoch,
                ...(request.attach.affinity ? { affinity: request.attach.affinity } : {}),
              },
              ...(request.executeHostEffects !== undefined
                ? { executeHostEffects: request.executeHostEffects }
                : {}),
              ...(request.activationOwnerId
                ? { activationOwnerId: request.activationOwnerId }
                : {}),
            });
            if (childRun.state === "parked") {
              shutdownReason = "parked";
              return childRun;
            }
            childOutcome =
              childRun.state === "completed"
                ? { status: "ok", value: childRun.value }
                : childRun.state === "cancelled"
                  ? { status: "cancelled" }
                  : { status: "error", error: childRun.error };
          }
          if (!reservation.resolutionCapability) {
            throw new CrankError("runtime_error", "Child pull has no resolution capability");
          }
          const childResolution = yield* resolveCommand({
            capability: reservation.resolutionCapability,
            audience: "child-runtime",
            outcome: childOutcome,
          });
          if (childResolution.status === "rejected") {
            throw new CrankError(childResolution.code);
          }
          pullIndex += 1;
          step = yield* ProgramPeer.operations.step(attachment, {
            type: "resume",
            actionIndex: step.actionIndex,
            outcome: childOutcome,
            receipt: childResolution.receipt,
            replayed: false,
          });
          continue;
        }
        if (reservation.status === "authorized" && descriptor.kind === "record") {
          const authorized = yield* ProgramPeer.operations.step(attachment, {
            type: "authorize",
            actionIndex: step.actionIndex,
            pullId: reservation.pullId,
            attemptId: reservation.attemptId,
            resolutionCapability: reservation.resolutionCapability,
            descriptor: reservation.descriptor,
          });
          if (
            authorized.type !== "operation" ||
            authorized.actionIndex !== step.actionIndex ||
            !authorized.authorizedOutcome
          ) {
            throw new CrankError("program_protocol_error", "Driver did not settle recorded work");
          }
          let resolution = yield* resolveCommand({
            capability: reservation.resolutionCapability,
            audience: "program-execution",
            outcome: authorized.authorizedOutcome,
          });
          if (resolution.status === "rejected" && resolution.code === "payload_too_large") {
            resolution = yield* resolveCommand({
              capability: reservation.resolutionCapability,
              audience: "program-execution",
              outcome: {
                status: "error",
                error: serializeDurableError(
                  new CrankError("record_value_too_large", "Recorded value exceeds inline limit"),
                ),
              },
            });
          }
          if (resolution.status === "rejected") {
            throw new CrankError(resolution.code);
          }
          const resumed = yield* resumeResolvedOperation(
            authority,
            attachment,
            request,
            step,
            pullIndex,
            programCapability,
            "Resolved recording was not replayable",
          );
          step = resumed.step;
          pullIndex = resumed.pullIndex;
          continue;
        }
        if (
          reservation.status === "authorized" &&
          descriptor.kind === "effect" &&
          request.executeHostEffects
        ) {
          if (reservation.descriptor.kind !== "effect" || !reservation.effectContractDigest) {
            throw new CrankError("runtime_error", "Installed effect authorization is malformed");
          }
          const authorizationDescriptor = reservation.descriptor;
          const authorizationDigest = reservation.effectContractDigest;
          const definition = reservation.effectDefinition;
          if (!definition) {
            throw new CrankError("invalid_manifest", "Installed effect definition is unavailable");
          }
          const route = yield* DurableEffectRouting.operations.route({
            definition,
            effectContractDigest: authorizationDigest,
            sessionId: request.attach.sessionId,
            taskId: request.attach.taskId,
            pullId: reservation.pullId,
            attemptId: reservation.attemptId,
            program: request.attach.program,
            programRoute: request.attach.route,
          });
          if (route.placement !== "host" && route.placement !== "execution") {
            throw new CrankError("effect_placement_unavailable", "Effect route is invalid");
          }
          const journal = yield* authority.query({ type: "authority.identity" });
          const effectResolver = descriptor.resolver;
          const authorization: DurableEffectAuthorization = {
            sessionId: request.attach.sessionId,
            taskId: request.attach.taskId,
            pullId: reservation.pullId,
            attemptId: reservation.attemptId,
            descriptor: authorizationDescriptor,
            effectContractDigest: authorizationDigest,
            resolutionCapability: reservation.resolutionCapability,
            resolver: effectResolver,
          };
          let resolution: ResolveOperationResult;
          let executionOutcome: OperationOutcome | undefined;
          if (route.placement === "execution") {
            const authorized = yield* ProgramPeer.operations.step(attachment, {
              type: "authorize",
              actionIndex: step.actionIndex,
              pullId: reservation.pullId,
              attemptId: reservation.attemptId,
              resolutionCapability: reservation.resolutionCapability,
              descriptor: authorizationDescriptor,
              effectContractDigest: authorizationDigest,
              placement: {
                journal,
                program: request.attach.program,
                route: request.attach.route,
                driverKind: driverKind(request.attach.route),
              },
            });
            if (
              authorized.type !== "operation" ||
              authorized.actionIndex !== step.actionIndex ||
              !authorized.authorizedOutcome
            ) {
              throw new CrankError(
                "effect_placement_unavailable",
                "Execution effect implementation did not settle",
              );
            }
            executionOutcome = authorized.authorizedOutcome;
            resolution = yield* resolveCommand({
              capability: reservation.resolutionCapability,
              audience: effectResolver.audience,
              outcome: authorized.authorizedOutcome,
            });
          } else {
            resolution = yield* ProgramPlacementContext.with(
              {
                journal,
                program: request.attach.program,
                route: request.attach.route,
                driverKind: driverKind(request.attach.route),
              },
              function* () {
                return yield* executeDurableEffectAuthorization(authorization);
              },
            );
          }
          if (resolution.status === "rejected") {
            throw new CrankError(resolution.code);
          }
          if (executionOutcome !== undefined) {
            yield* acknowledgeDurableEffect(authorization, executionOutcome);
          }
          const resumed = yield* resumeResolvedOperation(
            authority,
            attachment,
            request,
            step,
            pullIndex,
            programCapability,
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
        authority &&
        error instanceof CrankError &&
        (error.code === "nondeterminism_detected" ||
          error.code === "history_not_exhausted" ||
          error.code === "replay_diverged")
      ) {
        yield* authority.command({
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
            {
              cause: error,
            },
          );
        }
      }
      throw error;
    } finally {
      if (attachment) {
        yield* ProgramPeer.operations.shutdown(attachment, shutdownReason);
      }
    }
  },
};

function* driverFor(kind: string): Operation<ProgramDriver> {
  const registry: ProgramDriverRegistry | undefined = yield* ProgramDriverRegistryContext.get();
  const driver = registry?.get(kind);
  if (!driver) {
    throw new CrankError("unknown_target", `No program driver for ${kind}`);
  }
  return driver;
}

function driverKind(route: ProgramRoute): string {
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
  { type: "requested" | "settling_effect" | "cancelling_children" | "unwinding" }
> {
  return (
    state.type === "requested" ||
    state.type === "settling_effect" ||
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
