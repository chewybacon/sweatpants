import type { Operation } from "effection";
import { canonicalDigest } from "@sweatpants/foundation";
import { CrankError } from "./errors.ts";
import { verifyProgramReplayEntry } from "./program-recovery.ts";
import { createApi } from "effection/experimental";
import { ProgramPeer } from "./program-driver.ts";
import {
  programRouteDriverKind,
  type ProgramAttachment,
  type ProgramCheckpoint,
  type ProgramRestoreRequest,
  type ReplayEntry,
  type RestoredProgramAttachment,
} from "./program-driver-contract.ts";

/** Complete authority-planned history, before any checkpoint suffix selection. */
export interface ProgramRecoveryRequest extends Omit<ProgramRestoreRequest, "replay"> {
  readonly replay: readonly ReplayEntry[];
}

/**
 * Scoped recovery policy over the existing program transport. Call only after
 * mandatory authority-plan validation; middleware cannot replace that validation.
 * Like ProgramPeer, this API has a working default rather than a required driver.
 */
export const ProgramRecovery = createApi("durable-execution:program-recovery", {
  *checkpoint(_attachment: ProgramAttachment): Operation<ProgramCheckpoint> {
    return { kind: "replay" };
  },
  *recover(request: ProgramRecoveryRequest): Operation<RestoredProgramAttachment> {
    return yield* ProgramPeer.operations.restore({
      ...request,
      checkpoint: { kind: "replay" },
    });
  },
});

/**
 * Install at the activation scope for one selected driver. Outer deployment
 * policy and observation remain effective regardless of installation order.
 * Unsupported formats delegate before touching compute; restore errors propagate.
 */
export function* installProgramCheckpointAcceleration(options: {
  readonly driverKind: string;
  readonly format: string;
}): Operation<void> {
  yield* ProgramRecovery.around(
    {
      *checkpoint([attachment], next) {
        if (attachment.driverKind !== options.driverKind) {
          return yield* next(attachment);
        }
        return yield* ProgramPeer.operations.checkpoint(attachment);
      },
      *recover([request], next) {
        const checkpoint = request.checkpoint;
        if (
          programRouteDriverKind(request.attach.route) !== options.driverKind ||
          checkpoint.kind !== "continuation" ||
          checkpoint.format !== options.format
        ) {
          return yield* next(request);
        }
        return yield* ProgramPeer.operations.restore({
          ...request,
          replay: request.replay.filter(
            (entry) => entry.actionIndex > checkpoint.resumeAfter.actionIndex,
          ),
        });
      },
    },
    { at: "min" },
  );
}

/**
 * Input must come from the authority's plan, not an untrusted caller. Chain
 * checks establish consistency with that plan; they do not establish authority.
 * Validation surrounds policy dispatch and cannot be disabled by middleware.
 */
export function* recoverProgram(
  request: ProgramRecoveryRequest,
): Operation<RestoredProgramAttachment> {
  let chain = request.replayChainSeed;
  let through = -1;
  for (const entry of request.replay) {
    verifyProgramReplayEntry(request.replayChainSeed, entry, chain);
    if (entry.actionIndex !== through + 1) {
      throw new CrankError("replay_diverged", "Recovery history is not contiguous");
    }
    chain = entry.entryDigest;
    through = entry.actionIndex;
  }
  if (chain !== request.replayChainDigest || through !== request.replayedThroughActionIndex) {
    throw new CrankError("replay_diverged", "Recovery history differs from planned head");
  }
  const checkpoint = request.checkpoint;
  if (checkpoint.kind === "continuation") {
    const anchor = checkpoint.resumeAfter;
    const anchorDigest =
      anchor.actionIndex === -1
        ? request.replayChainSeed
        : request.replay.find((entry) => entry.actionIndex === anchor.actionIndex)?.entryDigest;
    if (
      !Number.isSafeInteger(anchor.actionIndex) ||
      anchor.actionIndex < -1 ||
      anchor.actionIndex > through ||
      anchorDigest !== anchor.replayChainDigest ||
      checkpoint.programDigest !== request.attach.program.digest
    ) {
      throw new CrankError("replay_diverged", "Checkpoint anchor differs from accepted history");
    }
  }
  const restored = yield* ProgramRecovery.operations.recover(request);
  let accepted = false;
  try {
    if (
      restored.replayChainDigest !== chain ||
      restored.replayedThroughActionIndex !== through ||
      restored.frontierDigest !== canonicalDigest(restored.frontier)
    ) {
      throw new CrankError("replay_diverged", "Recovery result differs from planned head");
    }
    accepted = true;
    return restored;
  } finally {
    if (!accepted) {
      yield* ProgramPeer.operations.shutdown(restored.attachment, "failed");
    }
  }
}
