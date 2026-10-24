import type { GuestWork, IterableOperation } from "./primitives.ts";
import type { Activation, Json, PendingJournal } from "./contract.ts";
import { replayGuest } from "./guest-turn.ts";

/** One bounded activation; parking persists a request and releases all compute. */
export function* activateJournal<T extends Json, Request extends Json, Y>(
  work: GuestWork<T, Request, Y, Json, Json>,
  journal: PendingJournal,
): IterableOperation<Activation<T>, Y> {
  const guest = yield* work();
  try {
    const { turn, sequence } = yield* replayGuest(guest, journal.read());
    if (turn.kind === "suspended") {
      return { state: "parked", request: journal.park(sequence, turn.request) };
    }
    journal.complete(sequence, turn.value);
    return { state: "completed", value: turn.value };
  } finally {
    yield* guest.close();
  }
}
