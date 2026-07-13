import { createContext, type Operation } from "effection";
import { createApi } from "effection/experimental";

import { assertInlineSize, assertSchemaValue, serializeDurableError } from "./authoring.ts";
import { CrankError, type Json } from "./types.ts";
import { ProgramDriverRegistryContext, type ProgramDriverRegistry } from "./program-driver.ts";
import type {
  AppendEmissionRequest,
  CompleteTaskRequest,
  DurableEffectAuthorization,
  DurableEffectContext,
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
  ProgramRunRequest,
  ProgramRoute,
  ProgramRunResult,
  ProgramShutdownReason,
  ProgramStep,
  ReserveOperationRequest,
  ReserveOperationResult,
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

/** Binds a typed effect definition to a schema-parsing Effection handler. */
export function createDurableEffectRegistration<I extends Json, O extends Json>(
  definition: EffectDefinition<I, O>,
  satisfies: DurableEffectRegistration["satisfies"],
  handler: (input: I, context: DurableEffectContext) => Operation<O>,
): DurableEffectRegistration {
  return {
    definition,
    satisfies,
    handler(input, context) {
      const validated = assertSchemaValue<I>(definition.inputSchema, input);
      return handler(validated, context);
    },
  };
}

/** Creates an immutable registry and rejects duplicate symbolic effect names. */
export function createDurableEffectRegistry(
  registrations: Iterable<DurableEffectRegistration>,
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
    const input = assertSchemaValue(
      registration.definition.inputSchema,
      authorization.descriptor.input,
      "invalid_descriptor",
    );
    const controller = new AbortController();
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
      let rawValue: unknown;
      try {
        rawValue = yield* operation;
      } finally {
        controller.abort();
      }
      const value = assertSchemaValue(registration.definition.outputSchema, rawValue);
      assertInlineSize(value);
      outcome = { status: "ok", value };
    } catch (error) {
      outcome = { status: "error", error: serializeDurableError(error) };
    }
    return yield* JournalAuthority.operations.resolve({
      capability: authorization.resolutionCapability,
      audience: authorization.resolver.audience,
      outcome,
    });
  },
});

/** Structured runtime API that drives programs and their child topology to a durable boundary. */
export const ProgramRuntime = createApi("crank-program-runtime", {
  *run(request: ProgramRunRequest): Operation<ProgramRunResult> {
    let attachment: ProgramAttachment | undefined;
    let shutdownReason: ProgramShutdownReason = "scope_exit";
    try {
      attachment = yield* ProgramPeer.operations.attach(request.attach);
      const authority = yield* useJournalAuthority();
      const programCapability =
        request.programCapability ??
        (yield* authority.bindProgramAttachment(
          request.attach.sessionId,
          request.attach.taskId,
          attachment.attachmentId,
          request.attach.executionEpoch,
        )).programCapability;
      let step = yield* ProgramPeer.operations.step(attachment, {
        type: "start",
        input: request.attach.input,
      });
      let pullIndex = 0;
      while (true) {
        if (step.type === "completed") {
          yield* JournalAuthority.operations.complete({
            sessionId: request.attach.sessionId,
            taskId: request.attach.taskId,
            actionIndex: step.actionIndex,
            outcome: { status: "ok", value: step.value },
            programCapability,
          });
          shutdownReason = "completed";
          return { state: "completed", value: step.value };
        }
        if (step.type === "failed") {
          const cancelled = step.error.code === "program_cancelled";
          yield* JournalAuthority.operations.complete({
            sessionId: request.attach.sessionId,
            taskId: request.attach.taskId,
            actionIndex: step.actionIndex,
            outcome: cancelled ? { status: "cancelled" } : { status: "error", error: step.error },
            programCapability,
          });
          shutdownReason = cancelled ? "cancelled" : "failed";
          return cancelled ? { state: "cancelled" } : { state: "failed", error: step.error };
        }
        if (step.type === "emission") {
          const receipt = yield* JournalAuthority.operations.emit({
            sessionId: request.attach.sessionId,
            taskId: request.attach.taskId,
            actionIndex: step.actionIndex,
            descriptor: step.descriptor,
            programCapability,
          });
          step = yield* ProgramPeer.operations.step(attachment, {
            type: "ack_emission",
            actionIndex: step.actionIndex,
            offset: receipt.offset,
          });
          continue;
        }
        const reservation = yield* JournalAuthority.operations.reserve({
          sessionId: request.attach.sessionId,
          turnId: turnIdFor(request.attach.taskId),
          taskId: request.attach.taskId,
          actionIndex: step.actionIndex,
          pullIndex,
          descriptor: step.descriptor,
          programCapability,
        });
        if (reservation.status === "resolved") {
          pullIndex += 1;
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
          const manifest = yield* ProgramPeer.operations.manifest(request.attach.route, child);
          const childTask = yield* authority.ensureChildTask({
            sessionId: request.attach.sessionId,
            turnId: turnIdFor(request.attach.taskId),
            parentTaskId: request.attach.taskId,
            parentPullId: reservation.pullId,
            child,
            manifest,
            executionEpoch: request.attach.executionEpoch,
            audience: "program-runtime",
          });
          let childOutcome = childTask.outcome;
          if (!childOutcome) {
            const childRun = yield* ProgramRuntime.operations.run({
              attach: {
                sessionId: request.attach.sessionId,
                taskId: childTask.taskId,
                program: child,
                input: child.input,
                route: request.attach.route,
                executionEpoch: request.attach.executionEpoch,
              },
              ...(request.executeHostEffects !== undefined
                ? { executeHostEffects: request.executeHostEffects }
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
        if (
          reservation.status === "authorized" &&
          step.descriptor.kind === "effect" &&
          request.executeHostEffects
        ) {
          const resolution = yield* DurableEffects.operations.execute({
            sessionId: request.attach.sessionId,
            taskId: request.attach.taskId,
            pullId: reservation.pullId,
            attemptId: reservation.attemptId,
            descriptor: step.descriptor,
            resolutionCapability: reservation.resolutionCapability,
            resolver: step.descriptor.resolver,
          });
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
    return "generator";
  }
  const value = route["driverKind"] ?? route["kind"];
  return typeof value === "string" && value ? value : "generator";
}

function effectKey(name: string, version: string): string {
  return `${name}@${version}`;
}

function turnIdFor(taskId: string): string {
  const slash = taskId.indexOf("/");
  return slash === -1 ? "turn-0" : taskId.slice(0, slash);
}

function isOperation(value: unknown): value is Operation<unknown> {
  return Boolean(
    value &&
    typeof value === "object" &&
    Symbol.iterator in value &&
    typeof value[Symbol.iterator] === "function",
  );
}
