import { type Operation } from "effection";
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
  type ResolutionReceipt,
} from "@sweatpants/durable-execution";

import type { EffectRouter, JournalSamplingService } from "./advancement-ports.ts";
import type { ExecutionComposition } from "./execution-composition.ts";

/** A committed settlement ends this advancement; orchestration must re-plan
 * and replay this exact record before another bind. */
export type AdvancementDisposition =
  | AdvancementResult
  | {
      readonly state: "settled";
      readonly actionIndex: number;
      readonly outcome: OperationOutcome;
      readonly receipt: ResolutionReceipt;
      readonly attemptedInDriver: boolean;
      readonly frontier: Extract<ProgramStep, { readonly type: "operation" }>;
    };

/**
 * Crosses the live edge exactly once under one Mandate. Replay is absent from
 * this module by construction: it receives a CaughtUpLeaf and relative live
 * composition, never replay entries or a planning API.
 */
export function* advanceCaughtUpLeaf(request: {
  readonly caughtUp: CaughtUpLeaf;
  readonly execution: ExecutionComposition;
  readonly effects?: EffectRouter;
  readonly stageSampleInput?: JournalSamplingService;
}): Operation<AdvancementDisposition> {
  const { caughtUp, execution } = request;
  const attachment = caughtUp.restored.attachment;
  let step = caughtUp.restored.frontier;
  // A cancelled replay outcome already injected the typed cancellation into
  // authored code. The live phase must not inject it a second time.
  let cancellationInjected = caughtUp.frontierProof.cancellationReplayed;
  const attach: AttachProgramRequest = {
    sessionId: execution.mandate.address.sessionId,
    taskId: execution.mandate.address.taskId,
    program: execution.mandate.program,
    input: caughtUp.item.input,
    route: caughtUp.item.route,
    executionEpoch: execution.mandate.lease.epoch,
    ...(execution.mandate.placement.sandbox.mode === "reuse"
      ? { affinity: execution.mandate.placement.sandbox.affinity }
      : {}),
  };

  for (;;) {
    const cancellation = yield* execution.cancellation();
    if (
      cancellationInjected &&
      isCancellationInProgress(cancellation) &&
      cancellation.type !== "unwinding"
    ) {
      yield* execution.beginCancellationUnwind();
      continue;
    }
    if (!cancellationInjected && isCancellationInProgress(cancellation)) {
      if (cancellation.type !== "unwinding") yield* execution.beginCancellationUnwind();
      const reason = "reason" in cancellation ? cancellation.reason : undefined;
      step = yield* ProgramPeer.operations.step(attachment, {
        type: "cancel",
        ...(reason === undefined ? {} : { reason }),
      });
      cancellationInjected = true;
      continue;
    }

    if (step.type === "completed") {
      const outcome: OperationOutcome = isCancellationInProgress(cancellation)
        ? { status: "cancelled" }
        : { status: "ok", value: step.value };
      const closure = yield* execution.complete(outcome);
      if (closure.status === "rejected") {
        const error = { code: closure.code, message: closure.message };
        yield* execution.complete({ status: "error", error });
        return { state: "failed", error };
      }
      return outcome.status === "cancelled"
        ? { state: "cancelled" }
        : { state: "completed", value: step.value };
    }

    if (step.type === "failed") {
      const cancelled =
        step.error.code === "program_cancelled" || isCancellationInProgress(cancellation);
      yield* execution.complete(
        cancelled ? { status: "cancelled" } : { status: "error", error: step.error },
      );
      return cancelled ? { state: "cancelled" } : { state: "failed", error: step.error };
    }

    if (step.type === "emission") {
      try {
        const receipt = yield* execution.emit(step.descriptor);
        step = yield* ProgramPeer.operations.step(attachment, {
          type: "ack_emission",
          actionIndex: step.actionIndex,
          offset: receipt.offset,
        });
        continue;
      } catch (error) {
        if (!(error instanceof CrankError) || error.code !== "emission_quota_exceeded") {
          throw error;
        }
        const serialized = serializeDurableError(error);
        yield* execution.complete({ status: "error", error: serialized });
        return { state: "failed", error: serialized };
      }
    }

    const composed = yield* composeStep(step, attach, request.stageSampleInput);
    const reservation = yield* execution.reserve(composed.descriptor);
    if (reservation.status === "pending") {
      return { state: "parked", pullId: reservation.pullId, reason: reservation.reason };
    }

    if (composed.descriptor.kind === "record") {
      const authorized = yield* ProgramPeer.operations.step(attachment, {
        type: "authorize",
        actionIndex: step.actionIndex,
        pullId: reservation.pullId,
        attemptId: reservation.attemptId,
        resolutionCapability: reservation.resolutionCapability,
        descriptor: reservation.descriptor,
      });
      assertAuthorizedStep(authorized, step.actionIndex, "recorded work");
      let committedOutcome = authorized.authorizedOutcome;
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
      if (resolution.status === "rejected") throw new CrankError(resolution.code);
      return {
        state: "settled",
        actionIndex: step.actionIndex,
        outcome: committedOutcome,
        receipt: resolution.receipt,
        attemptedInDriver: true,
        frontier: step,
      };
    }

    if (composed.descriptor.kind === "effect") {
      if (!request.effects) {
        return { state: "parked", pullId: reservation.pullId, reason: "external_effect" };
      }
      if (reservation.descriptor.kind !== "effect" || !reservation.effectContractDigest) {
        throw new CrankError("runtime_error", "Installed effect authorization is malformed");
      }
      const definition = reservation.effectDefinition;
      if (!definition) throw new CrankError("invalid_manifest", "Effect definition unavailable");
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
      const route = yield* request.effects.route({ authorization, definition, placement });
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
      const resolution = yield* execution.resolve({
        capability: reservation.resolutionCapability,
        audience: composed.descriptor.resolver.audience,
        outcome,
      });
      if (resolution.status === "rejected") throw new CrankError(resolution.code);
      if (request.effects.acknowledge) {
        try {
          yield* request.effects.acknowledge({ authorization, outcome });
        } catch {
          // Journal acceptance is authoritative; acknowledgement is retryable.
        }
      }
      return {
        state: "settled",
        actionIndex: step.actionIndex,
        outcome,
        receipt: resolution.receipt,
        attemptedInDriver: route === "execution",
        frontier: step,
      };
    }

    throw new CrankError("runtime_error", "Authority authorized a non-executable operation");
  }
}

function* composeStep(
  step: Extract<ProgramStep, { type: "operation" }>,
  attach: AttachProgramRequest,
  stage: JournalSamplingService | undefined,
): Operation<Extract<ProgramStep, { type: "operation" }>> {
  if (!stage || step.descriptor.kind !== "sample") return step;
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

function isCancellationInProgress(value: { readonly type: string }): boolean {
  return value.type !== "none" && value.type !== "cancelled" && value.type !== "orphaned";
}
