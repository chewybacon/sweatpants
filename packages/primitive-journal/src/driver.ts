import type {
  Handler,
  HandlerMiddleware,
  IterableOperation,
  Outcome,
  Turn,
  Work,
} from "./primitives.ts";
import { advance } from "./iterator-turn.ts";
import { withMiddleware } from "./handler-middleware.ts";
import {
  encode,
  type AcceptedExchange,
  type Journal,
  type Json,
  type Snapshot,
  type RetryMode,
} from "./contract.ts";

function retryMode(request: Json): RetryMode {
  if (typeof request === "object" && request !== null && "retrySafety" in request) {
    const safety = request.retrySafety;
    if (
      typeof safety === "object" &&
      safety !== null &&
      "mode" in safety &&
      (safety.mode === "repeatable" || safety.mode === "unsafe")
    ) {
      return safety.mode;
    }
  }
  throw new Error("An exchange must declare repeatable or unsafe retry safety");
}

/** The single path by which either live or historical accepted replies enter a guest. */
function feed<T, Request extends Json>(
  iterator: Iterator<Request, T, unknown>,
  turn: Turn<T, Request>,
  entry: AcceptedExchange,
  sequence: number,
): Turn<T, Request> {
  if (
    turn.kind !== "suspended" ||
    entry.sequence !== sequence ||
    encode(turn.request) !== encode(entry.request)
  ) {
    throw new Error("Replay request mismatch");
  }
  if (entry.outcome.ok) {
    return advance(iterator, entry.outcome.value);
  }
  if (!iterator.throw) {
    throw entry.outcome.error;
  }
  const result = iterator.throw(entry.outcome.error);
  return result.done
    ? { kind: "completed", value: result.value }
    : { kind: "suspended", request: result.value };
}

/** Reconstruction cannot dispatch live work: there is no handler argument. */
export function replay<T extends Json, Request extends Json>(
  work: Work<T, Request>,
  snapshot: Snapshot,
) {
  const iterator = work()[Symbol.iterator]();
  let turn = advance(iterator);
  for (const [sequence, entry] of snapshot.entries.entries()) {
    turn = feed(iterator, turn, entry, sequence);
  }
  if (
    snapshot.status === "completed" &&
    (turn.kind !== "completed" || encode(turn.value) !== encode(snapshot.value))
  ) {
    throw new Error("Terminal replay mismatch");
  }
  return { iterator, turn, sequence: snapshot.entries.length };
}

/** Single-writer prototype. Optional middleware cannot bypass the journal commit below. */
export function* driveJournal<T extends Json, Request extends Json, Y>(
  work: Work<T, Request>,
  journal: Journal,
  handler: Handler<Request, Y, Outcome<Json, Json>>,
  middleware: readonly HandlerMiddleware<Request, Y, Outcome<Json, Json>>[] = [],
  afterAccepted: (entry: AcceptedExchange) => void = () => {},
): IterableOperation<T, Y> {
  const { iterator, ...state } = replay(work, journal.read());
  const handle = withMiddleware(handler, middleware);
  while (state.turn.kind === "suspended") {
    // Keep the proposed request stable even if a handler mutates its own copy.
    const request = JSON.parse(encode(state.turn.request)) as Request;
    const started = journal.begin(state.sequence, request, retryMode(request));
    if (started.kind === "uncertain") {
      throw new Error(`outcome_unknown: exchange ${state.sequence} may have happened`);
    }
    const outcome = yield* handle(JSON.parse(encode(request)) as Request);
    const accepted = journal.accept(state.sequence, request, outcome);
    afterAccepted(accepted); // fault-injection seam: commit has finished, reply not delivered
    state.turn = feed(iterator, state.turn, accepted, state.sequence++);
  }
  journal.complete(state.sequence, state.turn.value);
  return state.turn.value;
}
