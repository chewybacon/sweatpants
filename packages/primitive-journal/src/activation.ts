import type { GuestWork, IterableOperation, Handler, Outcome } from "./primitives.ts";
import {
  encode,
  type Activation,
  type Json,
  type PendingJournal,
  type RetryMode,
} from "./contract.ts";
import { replayGuest, validateReplayRequest } from "./guest-turn.ts";

/** One bounded activation; parking persists a request and releases all compute. */
export function* activateJournal<T extends Json, Request extends Json, Y>(
  work: GuestWork<T, Request, Y, Json, Json>,
  journal: PendingJournal,
  immediate?: {
    handler: Handler<Request, Y, Outcome<Json, Json>>;
    classify(request: Request): "park" | RetryMode;
    accepted?(): void;
  },
): IterableOperation<Activation<T>, Y> {
  if (journal.read().status !== "running" && journal.read().status !== "completed") {
    throw new Error("Execution is interrupted or failed");
  }
  const guest = yield* work();
  let failed = false;
  try {
    let { turn, sequence } = yield* replayGuest(guest, journal.read());
    while (turn.kind === "suspended") {
      const request = JSON.parse(encode(turn.request)) as Request;
      const mode = immediate?.classify(request) ?? "park";
      if (mode === "park" || !immediate) {
        return { state: "parked", request: journal.park(sequence, request) };
      }
      const started = journal.begin(sequence, request, mode);
      if (started.kind === "uncertain") {
        throw new Error(`outcome_unknown: exchange ${sequence} may have happened`);
      }
      const outcome = yield* immediate.handler(JSON.parse(encode(request)) as Request);
      const accepted = journal.accept(sequence, request, outcome);
      immediate.accepted?.();
      validateReplayRequest(turn, accepted, sequence++);
      turn = yield* guest.resume(accepted.outcome);
    }
    journal.complete(sequence, turn.value);
    return { state: "completed", value: turn.value };
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    try {
      yield* guest.close();
    } catch (error) {
      if (!failed) {
        // eslint-disable-next-line no-unsafe-finally -- A successful activation must report failed disposal; primary failures are preserved.
        throw error;
      }
    }
  }
}
