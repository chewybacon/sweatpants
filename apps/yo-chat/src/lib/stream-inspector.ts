import type { ChatStreamEvent, ChatTransportMiddleware } from "@sweatpants/chat-client";
import { resource, type Operation, type Stream } from "effection";

export type InspectorEventPhase = "live" | "replay";

export interface InspectorEventEntry {
  readonly sequence: number;
  readonly phase: InspectorEventPhase;
  readonly event: ChatStreamEvent;
  readonly receivedAt: number;
}

export interface StreamInspectorStore {
  snapshot(): readonly InspectorEventEntry[];
  subscribe(listener: () => void): () => void;
  observe(event: ChatStreamEvent, phase: InspectorEventPhase): void;
  clear(): void;
}

function scheduleFrame(flush: () => void): () => void {
  if (typeof globalThis.requestAnimationFrame === "function") {
    const handle = globalThis.requestAnimationFrame(flush);
    return () => globalThis.cancelAnimationFrame(handle);
  }
  const handle = globalThis.setTimeout(flush, 16);
  return () => globalThis.clearTimeout(handle);
}

export function createStreamInspectorStore(): StreamInspectorStore {
  let entries: readonly InspectorEventEntry[] = Object.freeze([]);
  let pending: InspectorEventEntry[] = [];
  let nextSequence = 0;
  let cancelScheduledFlush: (() => void) | undefined;
  const listeners = new Set<() => void>();

  const flush = (): void => {
    cancelScheduledFlush = undefined;
    if (pending.length === 0) {
      return;
    }
    const next = pending;
    pending = [];
    entries = Object.freeze([...entries, ...next]);
    for (const listener of [...listeners]) {
      listener();
    }
  };

  return {
    snapshot: () => entries,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    observe(event, phase) {
      pending.push({
        sequence: nextSequence++,
        phase,
        event,
        receivedAt: Date.now(),
      });
      cancelScheduledFlush ??= scheduleFrame(flush);
    },
    clear() {
      cancelScheduledFlush?.();
      cancelScheduledFlush = undefined;
      pending = [];
      nextSequence = 0;
      entries = Object.freeze([]);
      for (const listener of [...listeners]) {
        listener();
      }
    },
  };
}

function observeStream(
  source: Stream<ChatStreamEvent, void>,
  phase: InspectorEventPhase,
  store: StreamInspectorStore,
): Stream<ChatStreamEvent, void> {
  return resource(function* (provide) {
    const subscription = yield* source;
    yield* provide({
      *next(): Operation<IteratorResult<ChatStreamEvent, void>> {
        const result = yield* subscription.next();
        if (!result.done) {
          store.observe(result.value, phase);
        }
        return result;
      },
    });
  });
}

export function createStreamInspectorTransportMiddleware(
  store: StreamInspectorStore,
): readonly ChatTransportMiddleware[] {
  return [
    {
      *sendMessages(args, next) {
        const stream = yield* next(...args);
        return observeStream(stream, "live", store);
      },
      *reconnectToStream(args, next) {
        const stream = yield* next(...args);
        return stream === null ? null : observeStream(stream, "replay", store);
      },
    },
  ];
}
