import { call, type Operation } from "effection";
import { canonicalDigest, canonicalJson, sha256 } from "@sweatpants/foundation";
import { CrankError } from "./errors.ts";
import type {
  ProgramDriver,
  ProgramCheckpoint,
  ProgramRestoreRequest,
  ProgramStep,
  ReplayEntry,
  RestoredProgramAttachment,
} from "./program-driver-contract.ts";

/** Baseline recovery for drivers whose continuations are reconstructed by replay. */
export const replayProgramRecovery = {
  *checkpoint(): Operation<ProgramCheckpoint> {
    return { kind: "replay" };
  },
  *restore(
    this: ProgramDriver,
    request: ProgramRestoreRequest,
  ): Operation<RestoredProgramAttachment> {
    if (request.checkpoint.kind !== "replay") {
      throw new CrankError(
        "program_protocol_error",
        "Replay driver cannot restore a continuation checkpoint",
      );
    }
    const attachment = yield* this.attach(request.attach);
    let restored = false;
    try {
      let frontier = yield* this.step(attachment, { type: "start", input: request.attach.input });
      let previous = request.replayChainSeed;
      let through = -1;
      const iterator =
        request.replay[Symbol.iterator]?.() ?? request.replay[Symbol.asyncIterator]?.();
      if (!iterator) {
        throw new CrankError("invalid_descriptor", "Replay source has no iterator");
      }
      let exhausted = false;
      try {
        for (;;) {
          const next = yield* call(async () => await iterator.next());
          if (next.done) {
            exhausted = true;
            break;
          }
          const entry = next.value;
          verifyProgramReplayEntry(request.replayChainSeed, entry, previous);
          assertProgramReplayFrontier(frontier, entry);
          frontier = yield* this.step(
            attachment,
            entry.type === "operation"
              ? {
                  type: "resume",
                  actionIndex: entry.actionIndex,
                  outcome: entry.outcome,
                  receipt: entry.receipt,
                  replayed: true,
                }
              : { type: "ack_emission", actionIndex: entry.actionIndex, offset: entry.offset },
          );
          previous = entry.entryDigest;
          through = entry.actionIndex;
        }
      } finally {
        if (!exhausted && iterator.return) {
          yield* call(async () => await iterator.return!());
        }
      }
      if (
        previous !== request.replayChainDigest ||
        through !== request.replayedThroughActionIndex
      ) {
        throw new CrankError("replay_diverged", "Replay did not reach requested journal position");
      }
      const frontierDigest = canonicalDigest(frontier);
      restored = true;
      return {
        attachment,
        frontier,
        replayedThroughActionIndex: through,
        replayChainDigest: previous,
        frontierDigest,
      };
    } catch (error) {
      if (error instanceof CrankError) {
        throw error;
      }
      throw new CrankError("replay_diverged", "Evaluator failed while restoring history", {
        cause: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (!restored) {
        yield* this.shutdown(attachment, "failed");
      }
    }
  },
};

export function verifyProgramReplayEntry(seed: string, entry: ReplayEntry, previous: string): void {
  if (entry.previousEntryDigest !== previous) {
    throw new CrankError("replay_diverged", "Replay chain predecessor differs");
  }
  const { entryDigest: _ignored, ...body } = entry;
  const expected = sha256(
    canonicalJson({
      replayChainSeed: seed,
      previousEntryDigest: previous,
      entryWithoutEntryDigest: body,
    }),
  );
  if (expected !== entry.entryDigest) {
    throw new CrankError("replay_diverged", "Replay entry digest differs");
  }
}

export function assertProgramReplayFrontier(step: ProgramStep, entry: ReplayEntry): void {
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
        canonicalDigest(step.descriptor) !== entry.descriptorDigest)
    ) {
      throw new CrankError("replay_diverged", "Evaluator operation differs from history");
    }
  } else if (
    step.type !== "emission" ||
    canonicalDigest(step.descriptor) !== entry.descriptorDigest
  ) {
    throw new CrankError("replay_diverged", "Evaluator emission differs from history");
  }
}
