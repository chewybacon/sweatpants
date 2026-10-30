import {
  CrankError,
  verifyProgramReplayEntry,
  type CaughtUpLeaf,
  type ReplayItem,
  type ProgramStep,
} from "@sweatpants/durable-execution";
import { canonicalJson, sha256 } from "@sweatpants/foundation";

import type {
  AcceptedExtensionObservation,
  AcceptedExtensionRequest,
  AcceptedPrefixAnchor,
} from "../contract/authority-contract.ts";

export function acceptedPrefixAnchor(previous: CaughtUpLeaf): AcceptedPrefixAnchor {
  const { item } = previous;
  return {
    address: item.address,
    strand: item.strand,
    program: item.program,
    replayChainSeed: item.replayChainSeed,
    throughActionIndex: previous.frontierProof.replayedThroughActionIndex,
    replayChainDigest: previous.frontierProof.replayChainDigest,
  };
}

/** Validate only the extension against the already validated attachment prefix. */
export function validateAcceptedExtension(
  previous: CaughtUpLeaf,
  extension: AcceptedExtensionObservation,
  settled: AcceptedExtensionRequest["settled"],
): void {
  const anchor = acceptedPrefixAnchor(previous);
  if (canonicalJson(anchor) !== canonicalJson(extension.anchor) || !extension.entries.length) {
    throw new CrankError("replay_diverged", "Warm replay prefix changed");
  }
  let chain = anchor.replayChainDigest;
  let index = anchor.throughActionIndex;
  let cancellation = previous.frontierProof.cancellationReplayed;
  let matched = false;
  for (const entry of extension.entries) {
    if (entry.actionIndex !== ++index) {
      throw new CrankError("replay_diverged", "Warm replay history has an action gap");
    }
    verifyProgramReplayEntry(anchor.replayChainSeed, entry, chain);
    chain = entry.entryDigest;
    if (entry.type === "operation") {
      cancellation ||= entry.outcome.status === "cancelled";
      if (entry.actionIndex === settled.actionIndex) {
        const receipt = settled.receipt;
        matched =
          (receipt.status === "accepted" || receipt.status === "duplicate") &&
          entry.receipt.sessionId === receipt.sessionId &&
          entry.receipt.taskId === receipt.taskId &&
          entry.receipt.pullId === receipt.pullId &&
          entry.receipt.resolutionOffset === receipt.resolutionOffset &&
          entry.receipt.outcomeDigest === receipt.outcomeDigest;
      }
    }
  }
  if (
    chain !== extension.replayChainDigest ||
    index !== extension.replayedThroughActionIndex ||
    index !== extension.plannedHead.actionIndex ||
    cancellation !== extension.cancellationReplayed
  ) {
    throw new CrankError("replay_diverged", "Warm replay did not reach the planned head");
  }
  if (!matched) {
    throw new CrankError(
      "replay_diverged",
      "Warm replay settlement differs from committed operation",
    );
  }
}

/** Construct a proof only from the frontier actually returned by delivery. */
export function acceptedFrontier(
  previous: CaughtUpLeaf,
  extension: AcceptedExtensionObservation,
  step: ProgramStep,
): CaughtUpLeaf {
  // The cold checkpoint has been consumed. Binding obtains a fresh checkpoint.
  const { checkpoint: _checkpoint, ...prefix } = previous.item;
  const item: ReplayItem = {
    ...prefix,
    plannedHead: extension.plannedHead,
    executionEpoch: extension.executionEpoch,
    groupContext: extension.groupContext,
    replay: [...prefix.replay, ...extension.entries],
    replayedThroughActionIndex: extension.replayedThroughActionIndex,
    replayChainDigest: extension.replayChainDigest,
  };
  const chain = item.replayChainDigest;
  const frontierDigest = sha256(
    canonicalJson({
      domain: "sweatpants.caught-up-frontier.v1",
      strandHeadDigest: item.plannedHead.digest,
      replayChainDigest: chain,
      frontier: step,
    }),
  );
  const cancellationReplayed = extension.cancellationReplayed;
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
