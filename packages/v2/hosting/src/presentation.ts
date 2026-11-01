import type { Operation } from "@standard-durability/core";
import { projectJournalState } from "./presentation-state.ts";
import type { Journal } from "@sweatpan.ts/durable";
import type { JournalPresentationPage, PresentationCursor } from "./contracts.ts";

/** Internal reader: only journal reads, bounded history access and cursor verification. */
export function* readJournalPresentation<R, Q, V, E, S, Y>(
  journal: Pick<Journal<R, Q, V, E, S, Y>, "read"> & { readonly id: string },
  after?: PresentationCursor,
  limit = 128,
): Operation<JournalPresentationPage<R, Q, V, E>, Y> {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new Error("Invalid presentation page limit");
  }
  const position = after?.position ?? 0;
  if (
    after &&
    (after.execution !== journal.id || !Number.isSafeInteger(position) || position < 0)
  ) {
    throw new Error("Invalid presentation cursor");
  }
  const snapshot = yield* journal.read();
  if (position > snapshot.history.end.position) {
    throw new Error("Presentation cursor is beyond accepted history");
  }
  const anchor = position === 0 ? null : (yield* snapshot.history.at(position - 1))?.receipt;
  if (anchor === undefined || (after && after.receipt !== anchor)) {
    throw new Error("Presentation cursor differs from accepted history");
  }
  const entries = yield* snapshot.history.read(position, limit);
  const last = entries.at(-1);
  const next = last ? last.sequence + 1 : position;
  const state = projectJournalState(snapshot);
  return {
    entries,
    after: { execution: journal.id, position: next, receipt: last?.receipt ?? anchor },
    caughtUp: next === snapshot.history.end.position,
    state,
  };
}
