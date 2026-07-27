import { definePort } from "@sweatpants/foundation/port";
import type { Json } from "@sweatpants/foundation";
import type { Operation } from "effection";
import type {
  HeadCommitResult,
  HistoryPage,
  HistoryPointer,
  HistorySegment,
  HistoryStore,
  SessionHead,
} from "./contract.ts";

export class HistoryStoreUnavailable extends Error {
  readonly code = "history_unavailable";
  constructor() {
    super("No history store driver is installed");
    this.name = "HistoryStoreUnavailable";
  }
}

function unavailable(): never {
  throw new HistoryStoreUnavailable();
}

/**
 * Session History persistence as a port.
 *
 * History storage stays a separate logical contract from execution storage even
 * when one physical backend implements both.
 */
export const HistoryStorePort = definePort<HistoryStore<Json>>("history-store", {
  *loadHead(_sessionId: string): Operation<SessionHead | null> {
    return unavailable();
  },
  *putSegment(_segment: HistorySegment<Json>): Operation<HistoryPointer> {
    return unavailable();
  },
  *compareAndSwapHead(
    _sessionId: string,
    _expectedRevision: number | null,
    _next: SessionHead,
  ): Operation<HeadCommitResult> {
    return unavailable();
  },
  *readPage(_sessionId: string, _cursor?: string, _limit?: number): Operation<HistoryPage<Json>> {
    return unavailable();
  },
});

export const HistoryStoreApi = HistoryStorePort.api;

/**
 * Installs one history-store adapter for the calling scope.
 *
 * Entry types belong to bounded contexts above this seam; storage treats them
 * as opaque validated JSON.
 */
export function installHistoryStore<Entry extends Json>(
  store: HistoryStore<Entry>,
): Operation<void> {
  // SAFETY: the driver only stores and returns entries it was given, so the
  // entry type is irrelevant to the storage mechanics behind this port.
  return HistoryStorePort.installDriver(store as unknown as HistoryStore<Json>);
}
