import { createContext, useScope, type Operation } from "effection";
import { createApi } from "effection/experimental";

import type { StandardSchemaV1 } from "@standard-schema/spec";

import { assertInlineSize, serializeDurableError } from "./authoring.ts";
import { assertJson, canonicalSnapshot } from "./canonical.ts";
import { CrankError, type Json } from "./types.ts";
import {
  DurableEffectRouting,
  effectContractDigest,
  registerLiveDurableEffect,
} from "@sweatpants/durable-effects/runtime";
import {
  ProgramDriverRegistryContext,
  ProgramExecutionScopeContext,
  type ProgramDriverRegistry,
} from "./program-driver.ts";
import { ProgramPlacementContext } from "./program-placement-context.ts";
import { ModelSamplingOutcomeAcknowledgerContext } from "./model-sampling-acknowledgement.ts";
import type {
  AppendEmissionRequest,
  CancellationFrontier,
  CompleteTaskRequest,
  DurableCancellationState,
  DurableEffectAuthorization,
  DurableEffectContext,
  DurableEffectDisposition,
  DurableEffectRegistration,
  DurableEffectRegistry,
  DurableJournalAuthorityService,
  DurableProgramManifest,
  EffectDefinition,
  EmissionReceipt,
  OperationOutcome,
  PinnedProgram,
  ProgramAttachment,
  ProgramCommand,
  ProgramDriver,
  ProgramRestoreRequest,
  ProgramRunRequest,
  ProgramRoute,
  ProgramRunResult,
  ProgramShutdownReason,
  ProgramStep,
  ReserveOperationRequest,
  ReserveOperationResult,
  RestoredFrontierProof,
  ResolveOperationRequest,
  ResolveOperationResult,
  TaskCloseReceipt,
} from "./durable-types.ts";

/** Scope-owned journal authority capability; absent outside an installed runtime. */
export const JournalAuthorityContext = createContext<DurableJournalAuthorityService | undefined>(
  "session-contract:journal-authority",
  undefined,
);
/** Scope-owned durable effect registry; handlers inherit caller cancellation. */
export const DurableEffectRegistryContext = createContext<DurableEffectRegistry | undefined>(
  "session-contract:durable-effect-registry",
  undefined,
);
/** Deployment-owned child placement policy; program code remains location-neutral. */
export const ProgramRouteResolverContext = createContext<
  ((program: PinnedProgram, parentRoute: ProgramRoute) => Operation<ProgramRoute>) | undefined
>("session-contract:program-route-resolver", undefined);

/** Optional scope-local runtime validators paired with one effect registration. */
export interface DurableEffectRuntimeSchemas {
  readonly input?: StandardSchemaV1;
  readonly output?: StandardSchemaV1;
}

const registrationSchemas = new WeakMap<DurableEffectRegistration, DurableEffectRuntimeSchemas>();

/** Reads scope-local runtime validators attached to a registration, if any. */
export function durableEffectRuntimeSchemas(
  registration: DurableEffectRegistration,
): DurableEffectRuntimeSchemas | undefined {
  return registrationSchemas.get(registration);
}

/** Binds a typed effect definition to an Effection handler with optional runtime validators. */
export function createDurableEffectRegistration<
  I extends Json,
  O extends Json,
  P extends Json = never,
>(
  definition: EffectDefinition<I, O, P>,
  satisfies: DurableEffectRegistration["satisfies"],
  handler: (input: I, context: DurableEffectContext) => Operation<DurableEffectDisposition<O, P>>,
  schemas?: DurableEffectRuntimeSchemas,
): DurableEffectRegistration {
  const registration: DurableEffectRegistration = {
    definition: definition as EffectDefinition<Json, Json, Json>,
    satisfies,
    handler(input, context) {
      // The authority validated and canonicalized this input at the reserve
      // boundary; the handler receives the recorded canonical value.
      // SAFETY: I is witnessed by the effect definition whose registered
      // validator accepted this value.
      return handler(input as I, context) as Operation<DurableEffectDisposition<Json, Json>>;
    },
  };
  if (schemas) {
    registrationSchemas.set(registration, schemas);
  }
  return registration;
}

/** Validates exact manifest contracts against the handlers selected by an assembly. */
export function validateDurableEffectBindings(
  requiredDefinitions: Iterable<EffectDefinition<Json, Json, Json>>,
  registry: DurableEffectRegistry,
): void {
  for (const required of requiredDefinitions) {
    const key = effectKey(required.name, required.version);
    const registration = registry.get(key);
    if (!registration) {
      throw new CrankError(
        "unknown_target",
        `No durable effect handler for ${required.name}@${required.version}`,
      );
    }
    if (effectContractDigest(registration.definition) !== effectContractDigest(required)) {
      throw new CrankError(
        "invalid_manifest",
        `Effect contract differs for ${required.name}@${required.version}`,
      );
    }
  }
}

/** Creates an immutable registry and optionally preflights required contracts. */
export function createDurableEffectRegistry(
  registrations: Iterable<DurableEffectRegistration>,
  requiredDefinitions: Iterable<EffectDefinition<Json, Json, Json>> = [],
): DurableEffectRegistry {
  const registry = new Map<string, DurableEffectRegistration>();
  for (const registration of registrations) {
    const definition = registration.definition;
    if (registry.has(effectKey(definition.name, definition.version))) {
      throw new CrankError(
        "invalid_manifest",
        `Duplicate effect ${definition.name}@${definition.version}`,
      );
    }
    if (registration.handler.constructor.name === "AsyncFunction") {
      throw new CrankError(
        "invalid_manifest",
        "Durable effect handlers must return Effection Operations, not Promises",
      );
    }
    if (
      registration.satisfies.mode !== definition.retrySafety.mode ||
      (definition.retrySafety.mode === "idempotent" &&
        (registration.satisfies.mode !== "idempotent" ||
          registration.satisfies.mechanism !== definition.retrySafety.mechanism))
    ) {
      throw new CrankError(
        "invalid_manifest",
        `Handler does not satisfy retry contract for ${definition.name}`,
      );
    }
    registry.set(effectKey(definition.name, definition.version), registration);
  }
  validateDurableEffectBindings(requiredDefinitions, registry);
  return registry;
}

/** Resolves the current scoped authority or fails fast when not installed. */
export function* useJournalAuthority(): Operation<DurableJournalAuthorityService> {
  const authority = yield* JournalAuthorityContext.get();
  if (!authority) {
    throw new CrankError("unknown_target", "No journal authority is installed");
  }
  return authority;
}

/** Resolves the current scoped effect registry or fails fast when not installed. */
export function* useDurableEffectRegistry(): Operation<DurableEffectRegistry> {
  const registry = yield* DurableEffectRegistryContext.get();
  if (!registry) {
    throw new CrankError("unknown_target", "No durable effect registry is installed");
  }
  return registry;
}

/** Native program-peer API for attaching, stepping, and shutting down a pinned driver. */
export const ProgramPeer = createApi("crank-program-peer", {
  *attach(request: Parameters<ProgramDriver["attach"]>[0]): Operation<ProgramAttachment> {
    const registry = yield* ProgramDriverRegistryContext.get();
    if (!registry) {
      throw new CrankError("unknown_target", "No program driver registry is installed");
    }
    const kind = driverKind(request.route);
    const driver = registry.get(kind);
    if (!driver) {
      throw new CrankError("unknown_target", `No program driver for ${kind}`);
    }
    return yield* driver.attach(request);
  },
  *step(attachment: ProgramAttachment, command: ProgramCommand): Operation<ProgramStep> {
    const driver = yield* driverFor(attachment.driverKind);
    return yield* driver.step(attachment, command);
  },
  *restore(request: ProgramRestoreRequest) {
    const driver = yield* driverFor(driverKind(request.attach.route));
    if (!driver.restore) {
      throw new CrankError("program_protocol_error", "Program driver has no restore fast path");
    }
    return yield* driver.restore(request);
  },
  *shutdown(attachment: ProgramAttachment, reason: ProgramShutdownReason): Operation<void> {
    const driver = yield* driverFor(attachment.driverKind);
    yield* driver.shutdown(attachment, reason);
  },
  *manifest(route: ProgramRoute, program: PinnedProgram): Operation<DurableProgramManifest> {
    const driver = yield* driverFor(driverKind(route));
    if (!driver.manifest) {
      throw new CrankError(
        "program_version_unavailable",
        `Driver ${driverKind(route)} cannot resolve program manifests`,
      );
    }
    return yield* driver.manifest(program);
  },
});

/** Native authority API mediating reserve, resolve, emit, and complete transitions. */
export const JournalAuthority = createApi("crank-journal-authority", {
  *reserve(request: ReserveOperationRequest): Operation<ReserveOperationResult> {
    const authority = yield* useJournalAuthority();
    return yield* authority.reserve(request);
  },
  *resolve(request: ResolveOperationRequest): Operation<ResolveOperationResult> {
    const authority = yield* useJournalAuthority();
    return yield* authority.resolve(request);
  },
  *emit(request: AppendEmissionRequest): Operation<EmissionReceipt> {
    const authority = yield* useJournalAuthority();
    return yield* authority.emit(request);
  },
  *complete(request: CompleteTaskRequest): Operation<TaskCloseReceipt> {
    const authority = yield* useJournalAuthority();
    return yield* authority.complete(request);
  },
});

/** Native host-effect API that journals authorization and resolution receipts. */
export const DurableEffects = createApi("crank-durable-effects", {
  *execute(authorization: DurableEffectAuthorization): Operation<ResolveOperationResult> {
    const registry = yield* useDurableEffectRegistry();
    const registration = registry.get(
      effectKey(authorization.descriptor.name, authorization.descriptor.version),
    );
    if (!registration) {
      throw new CrankError(
        "unknown_target",
        `No durable effect handler for ${authorization.descriptor.name}@${authorization.descriptor.version}`,
      );
    }
    if (effectContractDigest(registration.definition) !== authorization.effectContractDigest) {
      throw new CrankError(
        "invalid_manifest",
        `Effect contract differs for ${authorization.descriptor.name}@${authorization.descriptor.version}`,
      );
    }
    // The authority already ran defaults/transforms exactly once and returned
    // this effective descriptor with the authorization. Host dispatch performs
    // structural canonicalization only.
    const input = canonicalSnapshot(assertJson(authorization.descriptor.input)).value;
    const controller = new AbortController();
    const release = registerLiveDurableEffect(
      authorization.sessionId,
      authorization.taskId,
      authorization.pullId,
      authorization.attemptId,
      (reason) => controller.abort(reason),
    );
    let outcome: OperationOutcome;
    try {
      const operation = registration.handler(input, {
        sessionId: authorization.sessionId,
        taskId: authorization.taskId,
        pullId: authorization.pullId,
        attemptId: authorization.attemptId,
        cancellation: controller.signal,
        resolver: authorization.resolver,
      });
      if (!isOperation(operation)) {
        throw new CrankError(
          "invalid_manifest",
          "Durable effect handler returned a Promise or plain value",
        );
      }
      const disposition = yield* operation;
      if (!isEffectDisposition(disposition)) {
        throw new CrankError("invalid_manifest", "Durable effect returned an invalid disposition");
      }
      if (disposition.status === "ok") {
        // Output Standard Schema validation runs once in authority.resolve();
        // host code supplies only bounded canonical pre-validation input.
        const value = canonicalSnapshot(assertJson(disposition.value)).value;
        assertInlineSize(value);
        outcome = { status: "ok", value };
      } else if (disposition.status === "cancelled") {
        outcome =
          disposition.partial === undefined
            ? { status: "cancelled" }
            : { status: "cancelled", partial: disposition.partial };
      } else {
        outcome = { status: "error", error: disposition.error };
      }
    } catch (error) {
      outcome = controller.signal.aborted
        ? { status: "cancelled" }
        : { status: "error", error: serializeDurableError(error) };
    } finally {
      release();
      if (!controller.signal.aborted) {
        controller.abort();
      }
    }
    const resolution = yield* JournalAuthority.operations.resolve({
      capability: authorization.resolutionCapability,
      audience: authorization.resolver.audience,
      outcome,
    });
    if (resolution.status !== "rejected" && authorization.descriptor.name === "model.sample") {
      const acknowledge = yield* ModelSamplingOutcomeAcknowledgerContext.get();
      if (acknowledge) {
        try {
          yield* acknowledge({
            sessionId: authorization.sessionId,
            taskId: authorization.taskId,
            pullId: authorization.pullId,
            attemptId: authorization.attemptId,
            outcomeDigest: canonicalSnapshot(outcome).sha,
          });
        } catch {
          // Journal acceptance is authoritative. Remote retention remains
          // unacknowledged and recoverable for a later cleanup/retry path.
        }
      }
    }
    return resolution;
  },
});

/** Structured runtime API that drives programs and their child topology to a durable boundary. */
export const ProgramRuntime = createApi("crank-program-runtime", {
  *run(request: ProgramRunRequest): Operation<ProgramRunResult> {
    yield* ProgramExecutionScopeContext.set(yield* useScope());
    let attachment: ProgramAttachment | undefined;
    let authority: DurableJournalAuthorityService | undefined;
    let shutdownReason: ProgramShutdownReason = "scope_exit";
    try {
      authority = yield* useJournalAuthority();
      const acceptedInput = yield* authority.taskInput(
        request.attach.sessionId,
        request.attach.taskId,
      );
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
        const prepared = yield* authority.prepareProgramRestore({
          sessionId: acceptedAttach.sessionId,
          taskId: acceptedAttach.taskId,
          ownerId: request.activationOwnerId,
          activationEpoch: acceptedAttach.executionEpoch,
          releaseId: context.releaseId,
          sandboxSessionId: context.sandboxSessionId,
          replayDomain: context.replayDomain,
          frontierDomain: context.frontierDomain,
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
        programCapability ??= (yield* authority.bindProgramAttachment(
          request.attach.sessionId,
          request.attach.taskId,
          attachment.attachmentId,
          request.attach.executionEpoch,
        )).programCapability;
        const bound = yield* authority.bindRestoreFrontier({
          sessionId: acceptedAttach.sessionId,
          taskId: acceptedAttach.taskId,
          ownerId: request.activationOwnerId,
          activationEpoch: acceptedAttach.executionEpoch,
          restoreTicket: prepared.restoreTicket,
          frontierDigest: restored.frontierDigest,
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
      yield* authority.markActivationStarted(request.attach.sessionId);
      programCapability ??= (yield* authority.bindProgramAttachment(
        request.attach.sessionId,
        request.attach.taskId,
        attachment.attachmentId,
        request.attach.executionEpoch,
      )).programCapability;
      let cancellationInjected = false;
      while (true) {
        let cancellation = yield* authority.cancellationState(
          request.attach.sessionId,
          request.attach.taskId,
        );
        if (
          !cancellationInjected &&
          isCancellationInProgress(cancellation) &&
          shouldInjectBeforeStep(step, cancellation.frontier)
        ) {
          if (cancellation.type !== "unwinding") {
            cancellation = yield* authority.beginCancellationUnwind(
              request.attach.sessionId,
              request.attach.taskId,
              frontierProof ? { proof: frontierProof, step } : undefined,
            );
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
          if (isCancellationInProgress(cancellation) && cancellation.type !== "unwinding") {
            cancellation = yield* authority.beginCancellationUnwind(
              request.attach.sessionId,
              request.attach.taskId,
              frontierProof ? { proof: frontierProof, step } : undefined,
            );
            frontierProof = undefined;
          }
          const proof = frontierProof;
          yield* JournalAuthority.operations.complete({
            sessionId: request.attach.sessionId,
            taskId: request.attach.taskId,
            actionIndex: step.actionIndex,
            outcome: { status: "ok", value: step.value },
            programCapability,
            ...(proof ? { restoredFrontier: proof, restoredFrontierStep: step } : {}),
          });
          const cancelled = isCancellationInProgress(cancellation);
          shutdownReason = cancelled ? "cancelled" : "completed";
          return cancelled ? { state: "cancelled" } : { state: "completed", value: step.value };
        }
        if (step.type === "failed") {
          const cancelled =
            step.error.code === "program_cancelled" || isCancellationInProgress(cancellation);
          if (
            cancelled &&
            isCancellationInProgress(cancellation) &&
            cancellation.type !== "unwinding"
          ) {
            cancellation = yield* authority.beginCancellationUnwind(
              request.attach.sessionId,
              request.attach.taskId,
              frontierProof ? { proof: frontierProof, step } : undefined,
            );
            frontierProof = undefined;
          }
          const proof = frontierProof;
          try {
            yield* JournalAuthority.operations.complete({
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
            yield* authority.forceOrphan(
              request.attach.sessionId,
              request.attach.taskId,
              "replay_execution_failed",
            );
          }
          shutdownReason = cancelled ? "cancelled" : "failed";
          return cancelled ? { state: "cancelled" } : { state: "failed", error: step.error };
        }
        if (step.type === "emission") {
          const proof = frontierProof;
          let receipt: EmissionReceipt;
          try {
            receipt = yield* JournalAuthority.operations.emit({
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
            yield* JournalAuthority.operations.complete({
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
        const reservation = yield* JournalAuthority.operations.reserve({
          sessionId: request.attach.sessionId,
          turnId: turnIdFor(request.attach.taskId),
          taskId: request.attach.taskId,
          actionIndex: step.actionIndex,
          pullIndex,
          descriptor: step.descriptor,
          programCapability,
          ...(proof ? { restoredFrontier: proof, restoredFrontierStep: step } : {}),
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
              yield* authority.beginCancellationUnwind(
                request.attach.sessionId,
                request.attach.taskId,
                frontierProof ? { proof: frontierProof, step } : undefined,
              );
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
        if (reservation.status === "pending" && step.descriptor.kind === "invoke") {
          const child = step.descriptor.child;
          const routeResolver = yield* ProgramRouteResolverContext.get();
          const childRoute = routeResolver
            ? yield* routeResolver(child, request.attach.route)
            : request.attach.route;
          const manifest = yield* ProgramPeer.operations.manifest(childRoute, child);
          const childTask = yield* authority.ensureChildTask({
            sessionId: request.attach.sessionId,
            turnId: turnIdFor(request.attach.taskId),
            parentTaskId: request.attach.taskId,
            parentPullId: reservation.pullId,
            child,
            manifest,
            executionEpoch: request.attach.executionEpoch,
            audience: "program-runtime",
            route: childRoute,
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
          const childResolution = yield* JournalAuthority.operations.resolve({
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
        if (reservation.status === "authorized" && step.descriptor.kind === "record") {
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
          let resolution = yield* JournalAuthority.operations.resolve({
            capability: reservation.resolutionCapability,
            audience: "program-execution",
            outcome: authorized.authorizedOutcome,
          });
          if (resolution.status === "rejected" && resolution.code === "payload_too_large") {
            resolution = yield* JournalAuthority.operations.resolve({
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
          const replayed = yield* authority.reserve({
            sessionId: request.attach.sessionId,
            turnId: turnIdFor(request.attach.taskId),
            taskId: request.attach.taskId,
            actionIndex: step.actionIndex,
            pullIndex,
            descriptor: step.descriptor,
            programCapability,
          });
          if (replayed.status !== "resolved") {
            throw new CrankError("runtime_error", "Resolved recording was not replayable");
          }
          pullIndex += 1;
          step = yield* ProgramPeer.operations.step(attachment, {
            type: "resume",
            actionIndex: step.actionIndex,
            outcome: replayed.outcome,
            receipt: replayed.receipt,
            replayed: false,
          });
          continue;
        }
        if (
          reservation.status === "authorized" &&
          step.descriptor.kind === "effect" &&
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
          const journal = authority.journalIdentity();
          const effectResolver = step.descriptor.resolver;
          let resolution: ResolveOperationResult;
          if (route.placement === "execution") {
            const authorized = yield* ProgramPeer.operations.step(attachment, {
              type: "authorize",
              actionIndex: step.actionIndex,
              pullId: reservation.pullId,
              attemptId: reservation.attemptId,
              resolutionCapability: reservation.resolutionCapability,
              descriptor: authorizationDescriptor,
              effectContractDigest: authorizationDigest,
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
            resolution = yield* JournalAuthority.operations.resolve({
              capability: reservation.resolutionCapability,
              audience: effectResolver.audience,
              outcome: authorized.authorizedOutcome,
            });
          } else {
            const hostRegistry = yield* useDurableEffectRegistry();
            const hostRegistration = hostRegistry.get(
              effectKey(authorizationDescriptor.name, authorizationDescriptor.version),
            );
            if (
              !hostRegistration ||
              effectContractDigest(hostRegistration.definition) !== authorizationDigest
            ) {
              resolution = yield* JournalAuthority.operations.resolve({
                capability: reservation.resolutionCapability,
                audience: effectResolver.audience,
                outcome: {
                  status: "error",
                  error: serializeDurableError(
                    new CrankError(
                      "effect_placement_unavailable",
                      "Host effect implementation is unavailable",
                    ),
                  ),
                },
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
                  return yield* DurableEffects.operations.execute({
                    sessionId: request.attach.sessionId,
                    taskId: request.attach.taskId,
                    pullId: reservation.pullId,
                    attemptId: reservation.attemptId,
                    descriptor: authorizationDescriptor,
                    effectContractDigest: authorizationDigest,
                    resolutionCapability: reservation.resolutionCapability,
                    resolver: effectResolver,
                  });
                },
              );
            }
          }
          if (resolution.status === "rejected") {
            throw new CrankError(resolution.code);
          }
          const replayed = yield* authority.reserve({
            sessionId: request.attach.sessionId,
            turnId: turnIdFor(request.attach.taskId),
            taskId: request.attach.taskId,
            actionIndex: step.actionIndex,
            pullIndex,
            descriptor: step.descriptor,
            programCapability,
          });
          if (replayed.status !== "resolved") {
            throw new CrankError("runtime_error", "Resolved effect was not replayable");
          }
          pullIndex += 1;
          step = yield* ProgramPeer.operations.step(attachment, {
            type: "resume",
            actionIndex: step.actionIndex,
            outcome: replayed.outcome,
            receipt: replayed.receipt,
            replayed: false,
          });
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
        yield* authority.forceOrphan(
          request.attach.sessionId,
          request.attach.taskId,
          "replay_diverged",
        );
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
});

/** Bound ProgramPeer operations for composition without API-object lookup. */
export const {
  attach: attachProgram,
  restore: restoreProgram,
  step: stepProgram,
  shutdown: shutdownProgram,
  manifest: resolveProgramManifest,
} = ProgramPeer.operations;
/** Bound JournalAuthority operations for composition without API-object lookup. */
export const {
  reserve: reserveOperation,
  resolve: resolveOperation,
  emit: appendDurableEmission,
  complete: completeDurableTask,
} = JournalAuthority.operations;
/** Bound durable host-effect execution operation. */
export const { execute: executeDurableEffect } = DurableEffects.operations;
/** Bound durable program orchestration operation. */
export const { run: runDurableProgram } = ProgramRuntime.operations;

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

function effectKey(name: string, version: string): string {
  return `${name}@${version}`;
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

function shouldInjectBeforeStep(step: ProgramStep, frontier: CancellationFrontier): boolean {
  if (step.type === "completed" || step.type === "failed") {
    return step.actionIndex >= frontier.actionIndex;
  }
  return frontier.pullId === undefined
    ? step.actionIndex >= frontier.actionIndex
    : step.actionIndex > frontier.actionIndex;
}

function isEffectDisposition(value: unknown): value is DurableEffectDisposition<Json, Json> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const disposition = value as Record<string, unknown>;
  if (disposition["status"] === "ok") {
    return "value" in disposition;
  }
  if (disposition["status"] === "cancelled") {
    return true;
  }
  if (disposition["status"] !== "error") {
    return false;
  }
  const error = disposition["error"];
  return Boolean(
    error &&
    typeof error === "object" &&
    !Array.isArray(error) &&
    typeof (error as Record<string, unknown>)["code"] === "string" &&
    typeof (error as Record<string, unknown>)["message"] === "string",
  );
}

function isOperation(value: unknown): value is Operation<unknown> {
  return Boolean(
    value &&
    typeof value === "object" &&
    Symbol.iterator in value &&
    typeof value[Symbol.iterator] === "function",
  );
}
