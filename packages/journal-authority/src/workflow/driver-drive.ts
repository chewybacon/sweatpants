import { scoped, type Operation } from "effection";
import {
  CrankError,
  ProgramPeer,
  type AdvancementResult,
  type AttachProgramRequest,
  type ProgramDriver,
  type ProgramShutdownReason,
  type ReplayItem,
} from "@sweatpants/durable-execution";

import type { JournalAuthorityContract } from "../authority-contract.ts";
import {
  advanceCaughtUpLeaf,
  type AdvancementDisposition,
  type AdvancementServices,
} from "./advancement-drive.ts";
import { bindCaughtUpLeaf, livePlacement, requestedTargetPolicy } from "./advancement-policy.ts";
import { executionComposition } from "./execution-composition.ts";
import { replayStrand, replayWarmSuffix } from "./replay-walker.ts";

export type { EffectRouter, JournalSamplingService } from "./advancement-ports.ts";
export type { AdvancementServices } from "./advancement-drive.ts";

export interface DriveProgramDriverActivationRequest {
  readonly authority: JournalAuthorityContract;
  readonly driver: ProgramDriver;
  readonly attach: AttachProgramRequest;
  /** Owner of the task-scoped Mandate lease. */
  readonly activationOwnerId?: string;
  readonly advancement: AdvancementServices;
}

/**
 * Orchestrates the explicit replay → policy → bind → advancement pipeline.
 *
 * Replay always ends before selection. A committed effect/record settlement
 * disposes the attachment and starts a fresh plan; settled history never enters
 * through the live reservation result. Divergence is terminal and cannot fall
 * through to live execution.
 */
export function driveProgramDriverActivation(
  request: DriveProgramDriverActivationRequest,
): Operation<AdvancementResult> {
  return scoped(function* () {
    const ownerId = request.activationOwnerId ?? `direct:${request.attach.taskId}`;
    for (;;) {
      const plan = yield* request.authority.query({
        type: "forest.replay-plan",
        sessionId: request.attach.sessionId,
      });
      const row = plan.rows.find((candidate) => candidate.address.taskId === request.attach.taskId);
      if (row === undefined) throw new CrankError("unknown_target", "Task is absent from forest");
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
      const disposition = yield* runPreparedAdvancement(
        request,
        replayItemForAttachment(item, request.attach),
        ownerId,
      );
      if (disposition.state === "settled") continue;
      return disposition;
    }
  });
}

/** One mortal evaluator scope: caught-up state never survives a stale bind. */
function runPreparedAdvancement(
  request: DriveProgramDriverActivationRequest,
  item: ReplayItem,
  ownerId: string,
): Operation<AdvancementDisposition> {
  return scoped(function* () {
    let caughtUp;
    try {
      caughtUp = yield* replayStrand(item);
    } catch (error) {
      yield* orphanReplayDivergence(request.authority, item, error);
      throw error;
    }

    let shutdownReason: ProgramShutdownReason = "scope_exit";
    try {
      for (;;) {
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
        const execution = executionComposition(request.authority, mandate);
        let disposition: AdvancementDisposition;
        try {
          disposition = yield* advanceCaughtUpLeaf({
            caughtUp,
            execution,
            services: request.advancement,
          });
        } catch (error) {
          try {
            yield* execution.release("failed");
          } catch {
            // A settlement or terminal commit may already have ended the lease.
          }
          throw error;
        }
        if (disposition.state === "settled") {
          const nextPlan = yield* request.authority.query({
            type: "forest.replay-plan",
            sessionId: item.address.sessionId,
          });
          const nextItem = nextPlan.replay.find(
            (candidate) => candidate.address.taskId === item.address.taskId,
          );
          if (nextItem === undefined) {
            throw new CrankError("replay_diverged", "Settled strand was not replayable");
          }
          caughtUp = yield* replayWarmSuffix(
            caughtUp,
            replayItemForAttachment(nextItem, request.attach),
            disposition.actionIndex,
            disposition.attemptedInDriver,
            disposition.frontier,
          );
          continue;
        }
        shutdownReason = shutdownReasonFor(disposition);
        return disposition;
      }
    } catch (error) {
      shutdownReason = "failed";
      yield* orphanReplayDivergence(request.authority, item, error);
      throw error;
    } finally {
      yield* ProgramPeer.operations.shutdown(caughtUp.restored.attachment, shutdownReason);
    }
  });
}

function replayItemForAttachment(item: ReplayItem, attach: AttachProgramRequest): ReplayItem {
  return {
    ...item,
    route: attach.route,
    ...(attach.affinity === undefined ? {} : { affinity: attach.affinity }),
  };
}

function shutdownReasonFor(
  disposition: Exclude<AdvancementDisposition, { state: "settled" }>,
): ProgramShutdownReason {
  switch (disposition.state) {
    case "parked":
      return "parked";
    case "completed":
      return "completed";
    case "cancelled":
      return "cancelled";
    case "failed":
      return "failed";
  }
}

function* orphanReplayDivergence(
  authority: JournalAuthorityContract,
  item: ReplayItem,
  error: unknown,
): Operation<void> {
  if (!(error instanceof CrankError) || error.code !== "replay_diverged") return;
  yield* authority.command({
    type: "execution.force-orphan",
    request: {
      sessionId: item.address.sessionId,
      taskId: item.address.taskId,
      reason: "replay_diverged",
    },
  });
}

function outcomeResult(
  outcome: import("@sweatpants/durable-effects").OperationOutcome,
): AdvancementResult {
  switch (outcome.status) {
    case "ok":
      return { state: "completed", value: outcome.value };
    case "error":
      return { state: "failed", error: outcome.error };
    case "cancelled":
      return { state: "cancelled" };
  }
}
