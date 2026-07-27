import type { Json } from "@sweatpants/foundation";
import type { Operation } from "effection";

export interface HistoryPointer {
  readonly segmentId: string;
  readonly position: number;
}
export interface SessionHead {
  readonly sessionId: string;
  readonly revision: number;
  readonly historyHead: HistoryPointer | null;
  readonly activeExecutionId: string | null;
  readonly latestCompletedExecutionId: string | null;
}
export interface HistorySegment<Entry extends Json = Json> {
  readonly segmentId: string;
  readonly publicationKey: string;
  readonly sessionId: string;
  readonly previous: HistoryPointer | null;
  readonly firstPosition: number;
  readonly lastPosition: number;
  readonly entries: readonly Entry[];
}
export interface HistoryPage<Entry extends Json = Json> {
  readonly entries: readonly Entry[];
  readonly nextCursor: string | null;
  readonly previousCursor: string | null;
  readonly head: HistoryPointer | null;
}
export type HeadCommitResult =
  | { readonly status: "accepted"; readonly head: SessionHead }
  | { readonly status: "conflict"; readonly actual: SessionHead | null };
export interface HistoryStore<Entry extends Json = Json> {
  loadHead(sessionId: string): Operation<SessionHead | null>;
  putSegment(segment: HistorySegment<Entry>): Operation<HistoryPointer>;
  compareAndSwapHead(
    sessionId: string,
    expectedRevision: number | null,
    next: SessionHead,
  ): Operation<HeadCommitResult>;
  readPage(sessionId: string, cursor?: string, limit?: number): Operation<HistoryPage<Entry>>;
}
