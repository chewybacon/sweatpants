import { type Operation } from "effection";
import {
  CrankError,
  ProgramPeer,
  type CaughtUpLeaf,
  type ProgramStep,
  type ReplayEntry,
  type ReplayItem,
} from "@sweatpants/durable-execution";
import { canonicalJson, canonicalSnapshot, sha256 } from "@sweatpants/foundation";

/**
 * Reconstructs one planned strand and stops at its head (REQ-008..REQ-011).
 *
 * This module cannot command Authority: its complete input is ReplayItem plus
 * the evaluator transport. It has no capability, venue dispatcher, lease,
 * advancement policy, or authority port in scope. The same algorithm drives
 * local, worker, and remote ProgramDriver placements.
 */
export function* replayStrand(item: ReplayItem): Operation<CaughtUpLeaf> {
  const attachment = yield* ProgramPeer.operations.attach({
    sessionId: item.address.sessionId,
    taskId: item.address.taskId,
    program: item.program,
    input: item.input,
    route: item.route,
    executionEpoch: item.executionEpoch,
    ...(item.affinity === undefined ? {} : { affinity: item.affinity }),
  });
  let step: ProgramStep;
  try {
    step = yield* ProgramPeer.operations.step(attachment, { type: "start", input: item.input });
    let previous = item.replayChainSeed;
    let replayedThroughActionIndex = -1;
    let cancellationReplayed = false;
    for (const entry of item.replay) {
      verifyEntry(item, entry, previous);
      assertExpectedFrontier(step, entry);
      if (entry.type === "operation" && entry.outcome.status === "cancelled") {
        cancellationReplayed = true;
      }
      step =
        entry.type === "operation"
          ? yield* ProgramPeer.operations.step(attachment, {
              type: "resume",
              actionIndex: entry.actionIndex,
              outcome: entry.outcome,
              receipt: entry.receipt,
              replayed: true,
            })
          : yield* ProgramPeer.operations.step(attachment, {
              type: "ack_emission",
              actionIndex: entry.actionIndex,
              offset: entry.offset,
            });
      previous = entry.entryDigest;
      replayedThroughActionIndex = entry.actionIndex;
    }
    if (
      previous !== item.replayChainDigest ||
      replayedThroughActionIndex !== item.replayedThroughActionIndex ||
      replayedThroughActionIndex !== item.plannedHead.actionIndex
    ) {
      throw new CrankError("replay_diverged", "Replay did not stop at the planned strand head");
    }
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
    yield* ProgramPeer.operations.shutdown(attachment, "failed");
    if (error instanceof CrankError && error.code === "replay_diverged") throw error;
    throw new CrankError("replay_diverged", "Evaluator failed while replaying planned history", {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Replays only the newly committed suffix into a verified warm attachment.
 * This is still replay — it has no Authority argument or live capability —
 * and lets one host drive avoid re-running an already caught-up prefix.
 */
export function* replayWarmSuffix(
  previous: CaughtUpLeaf,
  item: ReplayItem,
  settledActionIndex: number,
  attemptedInDriver: boolean,
  warmFrontier: ProgramStep,
): Operation<CaughtUpLeaf> {
  if (
    previous.item.address.sessionId !== item.address.sessionId ||
    previous.item.address.taskId !== item.address.taskId ||
    previous.item.program.id !== item.program.id ||
    previous.item.program.version !== item.program.version ||
    previous.item.program.digest !== item.program.digest ||
    item.replay.length <= previous.item.replay.length
  ) {
    throw new CrankError("replay_diverged", "Warm replay target differs from caught-up strand");
  }
  const prefixLength = previous.item.replay.length;
  if (
    prefixLength > 0 &&
    item.replay[prefixLength - 1]!.entryDigest !== previous.item.replayChainDigest
  ) {
    throw new CrankError("replay_diverged", "Warm replay prefix changed");
  }
  let chain = item.replayChainSeed;
  for (const entry of item.replay) {
    verifyEntry(item, entry, chain);
    chain = entry.entryDigest;
  }

  let step = warmFrontier;
  for (const entry of item.replay.slice(previous.item.replay.length)) {
    // Emissions crossed earlier in the same advancement were already acked on
    // this warm attachment. They are verified in the new chain above but do
    // not get delivered twice.
    if (entry.actionIndex < settledActionIndex) {
      if (entry.type !== "emission") {
        throw new CrankError("replay_diverged", "Warm attachment skipped a settled operation");
      }
      continue;
    }
    assertExpectedFrontier(step, entry);
    step =
      entry.type === "operation"
        ? yield* ProgramPeer.operations.step(previous.restored.attachment, {
            type: "resume",
            actionIndex: entry.actionIndex,
            outcome: entry.outcome,
            receipt: entry.receipt,
            // This flag describes attempt provenance, not whether the feed
            // occurs in replay phase. Host effects were not attempted inside
            // the evaluator and therefore use replayed=true.
            replayed: !attemptedInDriver,
          })
        : yield* ProgramPeer.operations.step(previous.restored.attachment, {
            type: "ack_emission",
            actionIndex: entry.actionIndex,
            offset: entry.offset,
          });
  }
  if (
    chain !== item.replayChainDigest ||
    item.replayedThroughActionIndex !== item.plannedHead.actionIndex
  ) {
    throw new CrankError("replay_diverged", "Warm replay did not reach the planned head");
  }
  const frontierDigest = sha256(
    canonicalJson({
      domain: "sweatpants.caught-up-frontier.v1",
      strandHeadDigest: item.plannedHead.digest,
      replayChainDigest: chain,
      frontier: step,
    }),
  );
  const cancellationReplayed = item.replay.some(
    (entry) => entry.type === "operation" && entry.outcome.status === "cancelled",
  );
  return {
    item,
    restored: {
      attachment: previous.restored.attachment,
      frontier: step,
      replayedThroughActionIndex: item.replayedThroughActionIndex,
      replayChainDigest: chain,
      frontierDigest,
    },
    frontierProof: {
      frontierDigest,
      strandHeadDigest: item.plannedHead.digest,
      replayedThroughActionIndex: item.replayedThroughActionIndex,
      replayChainDigest: chain,
      cancellationReplayed,
    },
  };
}

function verifyEntry(item: ReplayItem, entry: ReplayEntry, previous: string): void {
  if (entry.previousEntryDigest !== previous) {
    throw new CrankError("replay_diverged", "Replay chain predecessor differs");
  }
  const { entryDigest: _ignored, ...body } = entry;
  const expected = sha256(
    canonicalJson({
      replayChainSeed: item.replayChainSeed,
      previousEntryDigest: previous,
      entryWithoutEntryDigest: body,
    }),
  );
  if (expected !== entry.entryDigest) {
    throw new CrankError("replay_diverged", "Replay entry digest differs");
  }
}

function assertExpectedFrontier(step: ProgramStep, entry: ReplayEntry): void {
  if (step.actionIndex !== entry.actionIndex) {
    throw new CrankError(
      "replay_diverged",
      `Evaluator action index ${step.actionIndex} differs from history ${entry.actionIndex}`,
    );
  }
  if (entry.type === "operation") {
    if (
      step.type !== "operation" ||
      step.descriptor.kind !== entry.descriptorKind ||
      (step.descriptor.kind !== "sample" &&
        canonicalSnapshot(step.descriptor).sha !== entry.descriptorDigest)
    ) {
      throw new CrankError("replay_diverged", "Evaluator operation differs from history");
    }
    return;
  }
  if (
    step.type !== "emission" ||
    canonicalSnapshot(step.descriptor).sha !== entry.descriptorDigest
  ) {
    throw new CrankError("replay_diverged", "Evaluator emission differs from history");
  }
}
