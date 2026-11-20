import type { Operation } from "@standard-durability/core";
import { projectJournalState } from "./presentation-state.ts";
import { readAcceptedHistoryPage, type Journal } from "@sweatpan.ts/durable";
import type { JournalPresentationPage, PresentationCursor } from "./contracts.ts";

/** Internal reader: only journal reads, bounded history access and cursor verification. */
export function* readJournalPresentation<R, Q, V, E, S, Y>(
  journal: Pick<Journal<R, Q, V, E, S, Y>, "read"> & { readonly id: string },
  after?: PresentationCursor,
  limit = 128,
): Operation<JournalPresentationPage<R, Q, V, E>, Y> {
  const snapshot = yield* journal.read();
  const page = yield* readAcceptedHistoryPage(journal.id, snapshot.history, after, limit);
  return { ...page, state: projectJournalState(snapshot) };
}
