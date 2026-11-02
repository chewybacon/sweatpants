import type { Guest, IterableOperation, Turn } from "./primitives.ts";
import { encode, type AcceptedExchange, type Json, type Snapshot } from "./contract.ts";

export function validateReplayRequest<T, Request extends Json>(
  turn: Turn<T, Request>,
  entry: AcceptedExchange,
  sequence: number,
): void {
  if (
    turn.kind !== "suspended" ||
    entry.sequence !== sequence ||
    encode(turn.request) !== encode(entry.request)
  ) {
    throw new Error("Replay request mismatch");
  }
}

export function validateReplayTerminal<T extends Json, Request>(
  turn: Turn<T, Request>,
  snapshot: Snapshot,
): void {
  if (
    snapshot.status === "completed" &&
    (turn.kind !== "completed" || encode(turn.value) !== encode(snapshot.value))
  ) {
    throw new Error("Terminal replay mismatch");
  }
}

/** No handler: reconstruction delivers only persisted Outcomes. Caller owns disposal. */
export function* replayGuest<T extends Json, Request extends Json, Y>(
  guest: Guest<T, Request, Y, Json, Json>,
  snapshot: Snapshot,
): IterableOperation<{ turn: Turn<T, Request>; sequence: number }, Y> {
  let turn = yield* guest.start();
  for (const [sequence, entry] of snapshot.entries.entries()) {
    validateReplayRequest(turn, entry, sequence);
    turn = yield* guest.resume(entry.outcome);
  }
  validateReplayTerminal(turn, snapshot);
  return { turn, sequence: snapshot.entries.length };
}
