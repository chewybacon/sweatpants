import { call, type Operation } from "effection";
import {
  CrankError,
  assertProgramReplayFrontier,
  verifyProgramReplayEntry,
  type ProgramRestoreRequest,
  type ProgramStep,
  type ReplayEntry,
} from "@sweatpants/durable-execution";
import { digestCanonicalJson, type Json } from "@sweatpants/foundation";
import type { ProgramHandler } from "./program-kernel.ts";
import type { ProgramReply } from "./program-execution.ts";

export interface Reconstruction {
  readonly request: ProgramRestoreRequest;
  readonly frontierDigest?: string;
}

/** Accepted history and live delivery have one position owner and one return site. */
export function createBoundarySession(
  initialIndex: number,
  live: ProgramHandler,
  clear: () => void,
  fail: (error: Error) => void,
  validate: (entry: ReplayEntry) => void,
  recovery?: Reconstruction,
) {
  let index = initialIndex;
  let previous =
    recovery?.request.checkpoint.kind === "continuation"
      ? recovery.request.checkpoint.resumeAfter.replayChainDigest
      : (recovery?.request.replayChainSeed ?? "");
  let through = initialIndex - 1;
  let reconstructing = recovery !== undefined;
  let first = true;
  let exhausted = false;
  let closed = false;
  let iterator: Iterator<ReplayEntry> | AsyncIterator<ReplayEntry> | undefined;
  let failure: Error | undefined;
  function reject(error: unknown): never {
    failure ??= error instanceof Error ? error : new Error(String(error));
    fail(failure);
    throw failure;
  }
  function* next(frontier: ProgramStep): Operation<ReplayEntry | undefined> {
    if (failure) {
      throw failure;
    }
    if (!reconstructing || !recovery) {
      return;
    }
    try {
      if (first) {
        first = false;
        if (
          recovery.frontierDigest !== undefined &&
          digestCanonicalJson(frontier as unknown as Json) !== recovery.frontierDigest
        ) {
          throw new CrankError("replay_diverged", "Restored workflow frontier differs");
        }
      }
      iterator ??=
        recovery.request.replay[Symbol.iterator]?.() ??
        recovery.request.replay[Symbol.asyncIterator]?.();
      if (!iterator) {
        throw new CrankError(
          recovery.request.checkpoint.kind === "replay"
            ? "invalid_descriptor"
            : "program_protocol_error",
          "Replay source has no iterator",
        );
      }
      const source = iterator;
      const item = yield* call(() => Promise.resolve(source.next()));
      if (item.done) {
        exhausted = true;
        if (
          through !== recovery.request.replayedThroughActionIndex ||
          previous !== recovery.request.replayChainDigest
        ) {
          throw new CrankError(
            "replay_diverged",
            "Recovery did not reach requested journal position",
          );
        }
        reconstructing = false;
        return;
      }
      const entry = item.value;
      verifyProgramReplayEntry(recovery.request.replayChainSeed, entry, previous);
      assertProgramReplayFrontier(frontier, entry);
      validate(entry);
      if (
        entry.type === "operation" &&
        (entry.receipt.sessionId !== recovery.request.attach.sessionId ||
          entry.receipt.taskId !== recovery.request.attach.taskId ||
          entry.receipt.outcomeDigest !== digestCanonicalJson(entry.outcome))
      ) {
        throw new CrankError("program_protocol_error", "resume receipt mismatch");
      }
      return entry;
    } catch (error) {
      return reject(error);
    }
  }
  const handle: ProgramHandler = function* (request) {
    if (failure) {
      throw failure;
    }
    const frontier: ProgramStep =
      request.kind === "record"
        ? {
            type: "operation",
            actionIndex: index,
            descriptor: request.boundary.serializable.descriptor,
          }
        : { type: "emission", actionIndex: index, descriptor: request.descriptor };
    const entry = yield* next(frontier);
    let reply: ProgramReply;
    try {
      reply = entry
        ? entry.type === "operation"
          ? { kind: "record", outcome: structuredClone(entry.outcome) }
          : { kind: "emission", value: entry.offset }
        : yield* live(request);
    } finally {
      // Explicit cancellation clears the rendezvous but does not advance position.
      clear();
    }
    index += 1;
    if (entry) {
      previous = entry.entryDigest;
      through = entry.actionIndex;
    }
    return reply;
  };
  return {
    handle,
    get index() {
      return index;
    },
    get failure() {
      return failure;
    },
    *finish(frontier: ProgramStep): Operation<void> {
      yield* next(frontier);
    },
    *closeRecovery(): Operation<void> {
      if (closed) {
        return;
      }
      closed = true;
      const close = iterator?.return?.bind(iterator);
      if (!exhausted && close) {
        try {
          yield* call(() => Promise.resolve(close()));
        } catch (error) {
          if (!failure) {
            throw error;
          }
          // Keep the primary validation error and expose teardown evidence to its caller.
          Object.defineProperty(failure, "reconstructionTeardownError", { value: error });
        }
      }
    },
  };
}
