import type { Runtime, Streams, Signal, Subscription } from "./contracts.ts";

/**
 * Compose scoped broadcast streams from native resource registration and Promise waiting.
 * Runtime adapters share these semantics; no separate scheduler or native task is created.
 */
export function createStreams<Y>(
  runtime: Pick<Runtime<Y>, "composition" | "fromPromise">,
): Streams<Y> {
  function createSignal<T, Close>(): Signal<T, Close, Y> {
    const subscribers = new Set<{
      send(value: T): void;
      close(value: Close): void;
    }>();
    return {
      send(value) {
        for (const subscriber of subscribers) {
          subscriber.send(value);
        }
      },
      close(value) {
        for (const subscriber of subscribers) {
          subscriber.close(value);
        }
      },
      *[Symbol.iterator]() {
        const queue: IteratorResult<T, Close>[] = [];
        let terminal: IteratorReturnResult<Close> | undefined;
        let active = true;
        let reading = false;
        let pending:
          | { resolve(value: IteratorResult<T, Close>): void; reject(error: unknown): void }
          | undefined;
        function publish(value: IteratorResult<T, Close>) {
          if (pending) {
            const waiter = pending;
            pending = undefined;
            waiter.resolve(value);
          } else {
            queue.push(value);
          }
        }
        const subscriber = {
          send(value: T) {
            if (!terminal) {
              publish({ done: false, value });
            }
          },
          close(value: Close) {
            if (!terminal) {
              terminal = { done: true, value };
              publish(terminal);
            }
          },
        };
        yield* runtime.composition.ensure(function* () {
          active = false;
          subscribers.delete(subscriber);
          queue.length = 0;
          pending?.reject(new Error("Stream subscription scope exited"));
          pending = undefined;
        });
        subscribers.add(subscriber);
        const subscription: Subscription<T, Close, Y> = {
          *next() {
            if (!active) {
              throw new Error("Stream subscription scope exited");
            }
            if (reading) {
              throw new Error("Concurrent subscription reads are unsupported");
            }
            reading = true;
            try {
              const buffered = queue.shift();
              if (buffered) {
                return buffered;
              }
              if (terminal) {
                return terminal;
              }
              return yield* runtime.fromPromise(
                (signal) =>
                  new Promise<IteratorResult<T, Close>>((resolve, reject) => {
                    const clean = () => {
                      signal.removeEventListener("abort", abort);
                      if (pending === waiter) {
                        pending = undefined;
                      }
                    };
                    const waiter = {
                      resolve(value: IteratorResult<T, Close>) {
                        clean();
                        resolve(value);
                      },
                      reject(error: unknown) {
                        clean();
                        reject(error);
                      },
                    };
                    const abort = () => waiter.reject(signal.reason);
                    signal.addEventListener("abort", abort, { once: true });
                    if (signal.aborted) {
                      abort();
                      return;
                    }
                    // Entering a native wait may yield. Recheck values published in that gap.
                    if (!active) {
                      waiter.reject(new Error("Stream subscription scope exited"));
                    } else {
                      const arrived = queue.shift();
                      if (arrived) {
                        waiter.resolve(arrived);
                      } else if (terminal) {
                        waiter.resolve(terminal);
                      } else {
                        pending = waiter;
                      }
                    }
                  }),
              );
            } finally {
              reading = false;
            }
          },
        };
        return subscription;
      },
    };
  }
  return {
    createSignal,
    createChannel<T, Close>() {
      const signal = createSignal<T, Close>();
      return {
        [Symbol.iterator]: signal[Symbol.iterator],
        *send(value: T) {
          signal.send(value);
        },
        *close(value: Close) {
          signal.close(value);
        },
      };
    },
  };
}
