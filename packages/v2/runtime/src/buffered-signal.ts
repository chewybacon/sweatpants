import type { BufferedSignal, Runtime, BufferedStream, BufferedSubscription } from "./contracts.ts";

/**
 * In-memory retained stream with independent readers, composed over live signals.
 * Sending requires no subscriber; subscribing defaults to replay from the beginning.
 * Close/failure is permanent, first terminal wins, and sending afterward throws.
 * Reader disposal never stops the producer or discards retained values. The owner
 * must bound this buffer's lifetime: there is no pruning, backpressure or persistence.
 * Values are not cloned. Notifications are coalesced; the buffer owns the truth.
 */
export function createBufferedSignal<T, Close = void, Y = never>(
  runtime: Pick<Runtime<Y>, "composition" | "createSignal">,
): BufferedSignal<T, Close, Y> {
  const values: T[] = [];
  const readers = new Set<() => void>();
  let terminal: { kind: "closed"; value: Close } | { kind: "failed"; error: unknown } | undefined;
  function notify() {
    for (const reader of readers) {
      reader();
    }
  }
  function from(
    offset: number,
    compact?: (previous: T, next: T) => T | undefined,
    maxValues = 256,
  ): BufferedStream<T, Close, Y> {
    return {
      *[Symbol.iterator]() {
        if (!Number.isSafeInteger(offset) || offset < 0 || offset > values.length) {
          throw new Error("Buffered stream offset is outside retained history");
        }
        if (!Number.isSafeInteger(maxValues) || maxValues < 1) {
          throw new Error("Buffered stream frame limit must be a positive safe integer");
        }
        const changed = runtime.createSignal<void>();
        const changes = yield* changed;
        let notified = false;
        let active = true;
        let reading = false;
        let cursor = offset;
        const wake = () => {
          if (!notified) {
            notified = true;
            changed.send();
          }
        };
        yield* runtime.composition.ensure(function* () {
          active = false;
          readers.delete(wake);
        });
        readers.add(wake);
        const subscription: BufferedSubscription<T, Close, Y> = {
          get offset() {
            return cursor;
          },
          *next() {
            if (!active) {
              throw new Error("Stream subscription scope exited");
            }
            if (reading) {
              throw new Error("Concurrent subscription reads are unsupported");
            }
            reading = true;
            try {
              while (true) {
                if (cursor < values.length) {
                  const end = cursor + Math.min(values.length - cursor, maxValues);
                  let consumed = cursor + 1;
                  let value: T = values[cursor]!;
                  if (compact) {
                    while (consumed < end) {
                      const merged = compact(value, values[consumed]!);
                      if (merged === undefined) {
                        break;
                      }
                      value = merged;
                      consumed++;
                    }
                  }
                  // Commit only after successful compaction, preserving retry/reconnect offsets.
                  cursor = consumed;
                  return { done: false, value };
                }
                if (terminal?.kind === "closed") {
                  return { done: true, value: terminal.value };
                }
                if (terminal?.kind === "failed") {
                  throw terminal.error;
                }
                // Subscribe before inspecting state. A notification is only a wakeup;
                // values and terminal state are rechecked after every native wait.
                yield* changes.next();
                notified = false;
              }
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
    [Symbol.iterator]: from(0)[Symbol.iterator],
    from,
    send(value) {
      if (terminal) {
        throw new Error("Buffered stream is already terminal");
      }
      values.push(value);
      notify();
    },
    close(value) {
      if (!terminal) {
        terminal = { kind: "closed", value };
        notify();
      }
    },
    fail(error) {
      if (!terminal) {
        terminal = { kind: "failed", error };
        notify();
      }
    },
  };
}
