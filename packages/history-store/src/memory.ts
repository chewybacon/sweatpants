import { call, type Operation } from "effection";
import { canonicalJson, type Json } from "@sweatpants/foundation";
import { HistorySegmentConflictError } from "./contract.ts";
import type {
  HeadCommitResult,
  HistoryPage,
  HistoryPointer,
  HistorySegment,
  HistoryStore,
  SessionHead,
} from "./contract.ts";

export function createMemoryHistoryStore<Entry extends Json = Json>(): HistoryStore<Entry> {
  const heads = new Map<string, SessionHead>();
  const segments = new Map<string, HistorySegment<Entry>>();
  const segmentBodies = new Map<string, string>();
  const publication = new Map<string, { pointer: HistoryPointer; body: string }>();
  return {
    *loadHead(sessionId): Operation<SessionHead | null> {
      return yield* call(() => heads.get(sessionId) ?? null);
    },
    *putSegment(segment): Operation<HistoryPointer> {
      return yield* call(() => {
        const body = canonicalSegment(segment);
        const existingPublication = publication.get(segment.publicationKey);
        if (existingPublication) {
          if (existingPublication.body !== body) {
            throw new HistorySegmentConflictError(
              `Publication key ${segment.publicationKey} already identifies different history content`,
            );
          }
          return existingPublication.pointer;
        }
        const existingSegment = segmentBodies.get(segment.segmentId);
        if (existingSegment !== undefined && existingSegment !== body) {
          throw new HistorySegmentConflictError(
            `Segment ${segment.segmentId} already contains different immutable history content`,
          );
        }
        const pointer = Object.freeze({
          segmentId: segment.segmentId,
          position: segment.lastPosition,
        });
        const stored = freezeSegment(segment);
        segments.set(segment.segmentId, stored);
        segmentBodies.set(segment.segmentId, body);
        publication.set(segment.publicationKey, { pointer, body });
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

function canonicalSegment<Entry extends Json>(segment: HistorySegment<Entry>): string {
  return canonicalJson({
    segmentId: segment.segmentId,
    publicationKey: segment.publicationKey,
    sessionId: segment.sessionId,
    previous: segment.previous
      ? { segmentId: segment.previous.segmentId, position: segment.previous.position }
      : null,
    firstPosition: segment.firstPosition,
    lastPosition: segment.lastPosition,
    entries: segment.entries,
  });
}

function freezeSegment<Entry extends Json>(segment: HistorySegment<Entry>): HistorySegment<Entry> {
  return Object.freeze({
    segmentId: segment.segmentId,
    publicationKey: segment.publicationKey,
    sessionId: segment.sessionId,
    previous: segment.previous
      ? Object.freeze({
          segmentId: segment.previous.segmentId,
          position: segment.previous.position,
        })
      : null,
    firstPosition: segment.firstPosition,
    lastPosition: segment.lastPosition,
    entries: Object.freeze(segment.entries.map((entry) => structuredClone(entry))),
  });
}
