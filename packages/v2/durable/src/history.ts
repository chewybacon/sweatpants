import type { Operation } from "@standard-durability/core";
import type { AcceptedHistory, AcceptedHistoryCursor, AcceptedHistoryPage } from "./contracts.ts";

/** Read one page from a captured prefix, validating its cursor and contiguous receipts. */
export function* readAcceptedHistoryPage<Q, V, E, Y>(
  execution: string,
  history: AcceptedHistory<Q, V, E, Y>,
  after?: AcceptedHistoryCursor,
  limit = 128,
): Operation<AcceptedHistoryPage<Q, V, E>, Y> {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new Error("Invalid accepted history page limit");
  }
  const position = after?.position ?? 0;
  if (after && (after.execution !== execution || !Number.isSafeInteger(position) || position < 0)) {
    throw new Error("Invalid accepted history cursor");
  }
  if (position > history.end.position) {
    throw new Error("Cursor is beyond accepted history");
  }
  const anchor = position === 0 ? null : (yield* history.at(position - 1))?.receipt;
  if (anchor === undefined || (after && after.receipt !== anchor)) {
    throw new Error("Cursor differs from accepted history");
  }
  const entries = yield* history.read(position, limit);
  if (
    entries.length > Math.min(limit, history.end.position - position) ||
    (position < history.end.position && !entries.length)
  ) {
    throw new Error("Invalid accepted history page");
  }
  for (const [index, entry] of entries.entries()) {
    if (entry.sequence !== position + index || !entry.receipt) {
      throw new Error("Invalid accepted history sequence");
    }
  }
  const last = entries.at(-1);
  const next = position + entries.length;
  const receipt = last?.receipt ?? anchor;
  const caughtUp = next === history.end.position;
  if (caughtUp && receipt !== history.end.receipt) {
    throw new Error("Accepted history frontier mismatch");
  }
  return { entries, after: { execution, position: next, receipt }, caughtUp };
}
