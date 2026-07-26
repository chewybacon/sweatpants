import { call, type Operation } from "effection";
import type { Json } from "@sweatpants/foundation";
import type {
  HeadCommitResult,
  HistoryPage,
  HistoryPointer,
  HistorySegment,
  HistoryStore,
  SessionHead,
} from "./index.ts";

export function createMemoryHistoryStore<Entry extends Json = Json>(): HistoryStore<Entry> {
  const heads = new Map<string, SessionHead>();
  const segments = new Map<string, HistorySegment<Entry>>();
  const publication = new Map<string, HistoryPointer>();
  return {
    *loadHead(sessionId): Operation<SessionHead | null> {
      return yield* call(() => heads.get(sessionId) ?? null);
    },
    *putSegment(segment): Operation<HistoryPointer> {
      return yield* call(() => {
        const existing = publication.get(segment.publicationKey);
        if (existing) return existing;
        const pointer = { segmentId: segment.segmentId, position: segment.lastPosition };
        segments.set(segment.segmentId, segment);
        publication.set(segment.publicationKey, pointer);
        return pointer;
      });
    },
    *compareAndSwapHead(sessionId, expectedRevision, next): Operation<HeadCommitResult> {
      return yield* call(() => {
        const actual = heads.get(sessionId) ?? null;
        if ((actual?.revision ?? null) !== expectedRevision)
          return { status: "conflict" as const, actual };
        heads.set(sessionId, next);
        return { status: "accepted" as const, head: next };
      });
    },
    *readPage(sessionId, cursor, limit = 50): Operation<HistoryPage<Entry>> {
      return yield* call(() => {
        const head = heads.get(sessionId)?.historyHead ?? null;
        const all: Entry[] = [];
        let pointer = head;
        while (pointer) {
          const segment = segments.get(pointer.segmentId);
          if (!segment || segment.sessionId !== sessionId) break;
          all.unshift(...segment.entries);
          pointer = segment.previous;
        }
        const start = cursor ? Number(cursor) : 0;
        const entries = all.slice(start, start + limit);
        const next = start + entries.length < all.length ? String(start + entries.length) : null;
        return {
          entries,
          nextCursor: next,
          previousCursor: start > 0 ? String(Math.max(0, start - limit)) : null,
          head,
        };
      });
    },
  };
}
