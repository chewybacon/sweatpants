import { resource, spawn, type Operation, type Stream } from "effection";

export type EagerBufferState<TDone> =
  | { readonly status: "open" }
  | { readonly status: "done"; readonly value: TDone }
  | { readonly status: "error"; readonly error: Error };

/**
 * A source-owned buffer with an atomic, nonblocking downstream drain.
 *
 * One structured child eagerly consumes the source stream. A slower consumer
 * calls drain() at its own cadence and receives exactly the values collected
 * since its previous drain.
 */
export interface EagerBuffer<T, TDone> {
  readonly state: EagerBufferState<TDone>;
  drain(): readonly T[];
}

/** Create a scope-owned eager stream consumer with a generic drainable buffer. */
export function createEagerBuffer<T, TDone>(
  source: Stream<T, TDone>,
): Operation<EagerBuffer<T, TDone>> {
  return resource(function* (provide) {
    const subscription = yield* source;
    let pending: T[] = [];
    let state: EagerBufferState<TDone> = Object.freeze({ status: "open" });

    yield* spawn(function* () {
      try {
        let next = yield* subscription.next();
        while (!next.done) {
          pending.push(next.value);
          next = yield* subscription.next();
        }
        state = Object.freeze({ status: "done", value: next.value });
      } catch (error) {
        state = Object.freeze({
          status: "error",
          error: error instanceof Error ? error : new Error(String(error)),
        });
      }
    });

    yield* provide({
      get state() {
        return state;
      },
      drain() {
        const batch = pending;
        pending = [];
        return batch;
      },
    });
  });
}
