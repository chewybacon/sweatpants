import type { Operation } from "effection";
import {
  CrankError,
  ProgramPeer,
  recoverProgram,
  type CaughtUpLeaf,
  type ReplayItem,
} from "@sweatpants/durable-execution";
import { canonicalJson, sha256 } from "@sweatpants/foundation";

/**
 * Reconstructs one planned strand and stops at its head (REQ-008..REQ-011).
 *
 * This module cannot command Authority: its complete input is ReplayItem plus
 * the evaluator transport. It has no capability, venue dispatcher, lease,
 * advancement policy, or authority port in scope. The same algorithm drives
 * local, worker, and remote ProgramDriver placements.
 */
export function* replayStrand(item: ReplayItem): Operation<CaughtUpLeaf> {
  const restored = yield* recoverProgram({
    attach: {
      sessionId: item.address.sessionId,
      taskId: item.address.taskId,
      program: item.program,
      input: item.input,
      route: item.route,
      executionEpoch: item.executionEpoch,
      /* CONDITIONAL-SPREAD: Omit absent affinity from journal commands, decisions, and replay records; explicit undefined is not a portable JSON value. */
      ...(item.affinity === undefined ? {} : { affinity: item.affinity }),
    },
    checkpoint: item.checkpoint ?? { kind: "replay" },
    replay: item.replay,
    replayChainSeed: item.replayChainSeed,
    replayChainDigest: item.replayChainDigest,
    replayedThroughActionIndex: item.replayedThroughActionIndex,
  });
  const {
    attachment,
    frontier: step,
    replayChainDigest: previous,
    replayedThroughActionIndex,
  } = restored;
  try {
    if (
      previous !== item.replayChainDigest ||
      replayedThroughActionIndex !== item.replayedThroughActionIndex ||
      replayedThroughActionIndex !== item.plannedHead.actionIndex
    ) {
      throw new CrankError("replay_diverged", "Recovery did not stop at the planned strand head");
    }
    const cancellationReplayed = item.replay.some(
      (entry) => entry.type === "operation" && entry.outcome.status === "cancelled",
    );
    const frontierDigest = sha256(
      canonicalJson({
        domain: "sweatpants.caught-up-frontier.v1",
        strandHeadDigest: item.plannedHead.digest,
        replayChainDigest: previous,
        frontier: step,
      }),
    );
    return {
      item,
      restored: {
        attachment,
        frontier: step,
        replayedThroughActionIndex,
        replayChainDigest: previous,
        frontierDigest,
      },
      frontierProof: {
        frontierDigest,
        strandHeadDigest: item.plannedHead.digest,
        replayedThroughActionIndex,
        replayChainDigest: previous,
        cancellationReplayed,
      },
    };
  } catch (error) {
    try {
      yield* ProgramPeer.operations.shutdown(attachment, "failed");
    } catch {
      /* Preserve the post-restore validation failure. */
    }
    throw error;
  }
}
