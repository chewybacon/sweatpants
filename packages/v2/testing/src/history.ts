import type { Operation } from "@standard-durability/core";
import type { Accepted, AcceptedHistory, Journal, JournalPosition } from "@sweatpan.ts/durable";

/** Collect a small journal fixture for assertions; production recovery reads bounded pages. */
export function* readJournal<R, Q, V, E, S, Y>(journal: Journal<R, Q, V, E, S, Y>) {
  const snapshot = yield* journal.read();
  const history: Accepted<Q, V, E>[] = [];
  while (history.length < snapshot.history.end.position) {
    const page = yield* snapshot.history.read(history.length, 128);
    if (!page.length) {
      throw new Error("Incomplete fixture history");
    }
    history.push(...page);
  }
  return { ...snapshot, history };
}

/** Trusted scripted storage peer, also used to inject damaged persisted evidence. */
export function historyFrom<Q, V, E, Y = never>(
  entries: readonly Accepted<Q, V, E>[],
  end: JournalPosition,
): AcceptedHistory<Q, V, E, Y> {
  return {
    end,
    *at(sequence): Operation<Accepted<Q, V, E> | undefined, Y> {
      return entries[sequence];
    },
    *read(from, limit): Operation<readonly Accepted<Q, V, E>[], Y> {
      return entries.slice(from, Math.min(end.position, from + limit));
    },
  };
}
