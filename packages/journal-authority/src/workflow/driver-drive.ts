import { scoped, type Operation } from "effection";
import {
  CrankError,
  ProgramPeer,
  installProgramCheckpointAcceleration,
  programRouteDriverKind,
  type AdvancementResult,
  type AttachProgramRequest,
  type ProgramDriver,
  type ProgramShutdownReason,
  type ReplayItem,
  assertProgramReplayFrontier,
  serializeDurableError,
} from "@sweatpants/durable-execution";

import type { JournalAuthorityContract } from "../contract/authority-contract.ts";
import type { OperationOutcome } from "@sweatpants/durable-effects";
import type { AdvancementServices } from "./advancement-ports.ts";
import {
  createAcceptanceHandler,
  deliverAccepted,
  type AcceptanceHandler,
  type AcceptedBatch,
} from "./accepted-boundary.ts";
import { ActivationFailure, createActivationLifetime } from "./activation-lifetime.ts";
import { acceptedFrontier } from "./accepted-history.ts";
import { bindCaughtUpLeaf, livePlacement, requestedTargetPolicy } from "./advancement-policy.ts";
import { executionComposition, type ExecutionComposition } from "./execution-composition.ts";
import { replayStrand } from "./replay-walker.ts";

export type { EffectRouter, JournalSamplingService } from "./advancement-ports.ts";
export type { AdvancementServices } from "./advancement-ports.ts";

export interface DriveProgramDriverActivationRequest {
  readonly authority: JournalAuthorityContract;
  readonly driver: ProgramDriver;
  readonly attach: AttachProgramRequest;
  /** Owner of the task-scoped Mandate lease. */
  readonly activationOwnerId?: string;
  readonly advancement: AdvancementServices;
}

/** Reconstruct once, then advance accepted boundaries within one attachment. */
export function driveProgramDriverActivation(
  request: DriveProgramDriverActivationRequest,
): Operation<AdvancementResult> {
  return scoped(function* () {
    const continuation = request.driver.capabilities.continuation;
    if (continuation) {
      yield* installProgramCheckpointAcceleration({
        driverKind: programRouteDriverKind(request.attach.route),
        format: continuation.format,
      });
    }
    const ownerId = request.activationOwnerId ?? `direct:${request.attach.taskId}`;
    {
      const plan = yield* request.authority.query({
        type: "forest.replay-plan",
        sessionId: request.attach.sessionId,
      });
      const row = plan.rows.find((candidate) => candidate.address.taskId === request.attach.taskId);
      if (row === undefined) {
        throw new CrankError("unknown_target", "Task is absent from forest");
      }
      if (row.classification === "terminal") {
        const recovery = yield* request.authority.query({
          type: "task.recovery-state",
          sessionId: request.attach.sessionId,
          taskId: request.attach.taskId,
        });
        if (recovery.status !== "terminal") {
          throw new CrankError("invalid_journal", "Terminal forest row has no terminal outcome");
        }
        return outcomeResult(recovery.outcome);
      }
      if (row.classification === "peer_hosted") {
        throw new CrankError("placement_unavailable", "Peer strand cannot activate locally");
      }
      if (row.classification === "structurally_blocked") {
        if (row.parked !== undefined) {
          return {
            state: "parked",
            pullId: row.parked.pullId,
            reason: row.parked.reason,
            slots: [
              {
                taskId: row.address.taskId,
                pullId: row.parked.pullId,
                reason: row.parked.reason,
              },
            ],
          };
        }
        throw new CrankError("stale_activation", "Strand is structurally blocked");
      }
      const item = plan.replay.find(
        (candidate) => candidate.address.taskId === request.attach.taskId,
      );
      if (item === undefined) {
        throw new CrankError("invalid_journal", "Replayable row has no replay item");
      }
      return yield* runPreparedAdvancement(
        request,
        replayItemForAttachment(item, request.attach),
        ownerId,
      );
    }
  });
}

/** One mortal evaluator scope: caught-up state never survives a stale bind. */
function runPreparedAdvancement(
  request: DriveProgramDriverActivationRequest,
  item: ReplayItem,
  ownerId: string,
): Operation<AdvancementResult> {
  return scoped(function* () {
    const lifetime = createActivationLifetime(request.authority, item);
    let caughtUp;
    try {
      caughtUp = yield* replayStrand(item);
    } catch (error) {
      yield* lifetime.failed(new ActivationFailure(error, "reconstruction"));
      throw error;
    }

    let shutdownReason: ProgramShutdownReason = "scope_exit";
    const attachment = caughtUp.restored.attachment;
    let step = caughtUp.restored.frontier;
    let execution: ExecutionComposition | undefined;
    let handle: AcceptanceHandler | undefined;
    let batch: AcceptedBatch | undefined;
    let cursor = 0;
    let cancellationInjected = caughtUp.frontierProof.cancellationReplayed;
    let primary = false;
    try {
      for (;;) {
        if (batch) {
          const entry = batch.extension.entries[cursor];
          if (entry) {
            cursor++;
            if (entry.actionIndex < batch.settledActionIndex) {
              if (entry.type !== "emission") {
                throw new ActivationFailure(
                  new CrankError("replay_diverged", "Warm attachment skipped a settled operation"),
                  "validation",
                );
              }
              continue;
            }
            try {
              assertProgramReplayFrontier(step, entry);
            } catch (error) {
              throw new ActivationFailure(error, "validation");
            }
            step = yield* deliverAccepted(
              attachment,
              entry.type === "operation"
                ? {
                    kind: "operation",
                    actionIndex: entry.actionIndex,
                    outcome: entry.outcome,
                    receipt: entry.receipt,
                    replayed: !batch.attemptedInDriver,
                  }
                : { kind: "emission", actionIndex: entry.actionIndex, offset: entry.offset },
            );
            continue;
          }
          try {
            caughtUp = acceptedFrontier(caughtUp, batch.extension, step);
          } catch (error) {
            throw new ActivationFailure(error, "validation");
          }
          batch = undefined;
          cancellationInjected = caughtUp.frontierProof.cancellationReplayed;
        }
        if (!execution || !handle) {
          const placement = livePlacement(
            request.attach.route,
            request.attach.affinity,
            request.driver.evaluatorKind,
          );
          const mandate = yield* bindCaughtUpLeaf(
            request.authority,
            caughtUp,
            requestedTargetPolicy(request.attach.taskId, placement),
            ownerId,
          );
          if (mandate === null) {
            throw new CrankError("stale_activation", "Prepared target lost the bind race");
          }

          execution = executionComposition(request.authority, mandate);
          lifetime.bound(execution);
          handle = createAcceptanceHandler({
            caughtUp,
            execution,
            services: request.advancement,
            authority: request.authority,
            onSettled: () => lifetime.settled(),
          });
        }
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
          if (cancellation.type !== "unwinding") {
            yield* execution.beginCancellationUnwind();
          }
          const reason = "reason" in cancellation ? cancellation.reason : undefined;
          try {
            step = yield* ProgramPeer.operations.step(attachment, {
              type: "cancel",
              /* CONDITIONAL-SPREAD: Omit absent reason from journal commands, decisions, and replay records; explicit undefined is not a portable JSON value. */
              ...(reason === undefined ? {} : { reason }),
            });
          } catch (error) {
            if (!(error instanceof CrankError) || error.code !== "stale_program_capability") {
              throw error;
            }
            // A scope-owned external attempt may dispose the evaluator while its
            // cancellation settles. Authority still owns terminal admission.
            yield* execution.complete({ status: "cancelled" });
            shutdownReason = "cancelled";
            return { state: "cancelled" };
          }
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
            shutdownReason = "failed";
            return { state: "failed", error };
          }
          shutdownReason = outcome.status === "cancelled" ? "cancelled" : "completed";
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
          shutdownReason = cancelled ? "cancelled" : "failed";
          return cancelled ? { state: "cancelled" } : { state: "failed", error: step.error };
        }

        const emission = step.type === "emission";
        try {
          const decision = yield* handle(step);
          if (decision.kind === "parked") {
            shutdownReason = "parked";
            return decision.result;
          }
          if (decision.kind === "emission") {
            step = yield* deliverAccepted(attachment, decision.reply);
          } else {
            batch = decision;
            cursor = 0;
            execution = undefined;
            handle = undefined;
          }
        } catch (failure) {
          const error = failure instanceof ActivationFailure ? failure.original : failure;
          if (
            !emission ||
            !(error instanceof CrankError) ||
            error.code !== "emission_quota_exceeded"
          ) {
            throw failure;
          }
          const serialized = serializeDurableError(error);
          yield* execution!.complete({ status: "error", error: serialized });
          shutdownReason = "failed";
          return { state: "failed", error: serialized };
        }
      }
    } catch (error) {
      primary = true;
      shutdownReason = "failed";
      const failure =
        error instanceof ActivationFailure ? error : new ActivationFailure(error, "live");
      yield* lifetime.failed(failure);
      throw failure.original;
    } finally {
      if (primary) {
        try {
          yield* ProgramPeer.operations.shutdown(attachment, shutdownReason);
        } catch {
          /* Preserve primary failure after attempting physical disposal. */
        }
      } else {
        yield* ProgramPeer.operations.shutdown(attachment, shutdownReason);
      }
    }
  });
}

function replayItemForAttachment(item: ReplayItem, attach: AttachProgramRequest): ReplayItem {
  return {
    ...item,
    route: attach.route,
    /* CONDITIONAL-SPREAD: Omit absent affinity from journal commands, decisions, and replay records; explicit undefined is not a portable JSON value. */
    ...(attach.affinity === undefined ? {} : { affinity: attach.affinity }),
  };
}

function outcomeResult(outcome: OperationOutcome): AdvancementResult {
  switch (outcome.status) {
    case "ok":
      return { state: "completed", value: outcome.value };
    case "error":
      return { state: "failed", error: outcome.error };
    case "cancelled":
      return { state: "cancelled" };
  }
}
function isCancellationInProgress(value: { readonly type: string }): boolean {
  return value.type !== "none" && value.type !== "cancelled" && value.type !== "orphaned";
}
