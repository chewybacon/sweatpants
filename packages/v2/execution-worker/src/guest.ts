import type { Operation, Outcome } from "@standard-durability/core";
import type { Guest, GuestCommand, GuestResponse, Turn } from "@sweatpan.ts/execution";
import type { Runtime } from "@sweatpan.ts/runtime";
import type { WorkerGuestOptions } from "./contracts.ts";
import { decodeResponse } from "./wire.ts";

/**
 * Proxy one remote Guest over a dedicated byte channel. Any uncertain response fences
 * this proxy: acquire a new incarnation and recover from the host journal, never retry
 * advancement here. Assembly must register close in the acquiring scope.
 */
export function createWorkerGuest<R, Q, Y, V = unknown, E = unknown>(
  runtime: Runtime<Y>,
  options: WorkerGuestOptions,
): Guest<R, Q, Y, V, E> {
  let sequence = 0;
  let busy = false;
  let poisoned = false;
  let closed = false;
  let shutdown: Promise<void> | undefined;
  function* exchange(command: GuestCommand<V, E>): Operation<GuestResponse<R, Q>, Y> {
    if (busy || poisoned || closed) {
      throw new Error("Worker Guest is unavailable");
    }
    busy = true;
    let finished = false;
    try {
      const response = yield* runtime.fromPromise(
        (signal) =>
          new Promise<GuestResponse<R, Q>>((resolve, reject) => {
            const clean = () => {
              options.port.removeEventListener("message", message);
              options.port.removeEventListener("messageerror", failure);
              signal.removeEventListener("abort", abort);
              options.failure.removeEventListener("abort", disconnected);
            };
            const fail = (error: unknown) => {
              clean();
              reject(error);
            };
            const message = (event: unknown) => {
              try {
                if (!event || typeof event !== "object" || !("data" in event)) {
                  throw new Error("Invalid message event");
                }
                const received = decodeResponse<R, Q>(options.codec, event.data);
                if (
                  received.incarnation !== options.incarnation ||
                  received.sequence !== command.sequence
                ) {
                  throw new Error("Mismatched Guest response");
                }
                clean();
                resolve(received);
              } catch (error) {
                fail(error);
              }
            };
            const failure = () => fail(new Error("Guest message transport failed"));
            const abort = () => fail(signal.reason);
            const disconnected = () => fail(options.failure.reason);
            options.port.addEventListener("message", message);
            options.port.addEventListener("messageerror", failure);
            signal.addEventListener("abort", abort, { once: true });
            options.failure.addEventListener("abort", disconnected, { once: true });
            if (options.failure.aborted) {
              disconnected();
              return;
            }
            if (signal.aborted) {
              abort();
              return;
            }
            try {
              options.port.start();
              // eslint-disable-next-line unicorn/require-post-message-target-origin -- Dedicated MessagePort, not Window.postMessage.
              options.port.postMessage(options.codec.encode(command));
            } catch (error) {
              fail(error);
            }
          }),
      );
      if (response.kind === "error") {
        throw new Error(response.message);
      }
      if ((command.action === "close") !== (response.kind === "closed")) {
        throw new Error("Unexpected Guest response");
      }
      finished = true;
      return response;
    } finally {
      busy = false;
      if (!finished) {
        poisoned = true;
      }
    }
  }
  function* advance(command: GuestCommand<V, E>): Operation<Turn<R, Q>, Y> {
    const response = yield* exchange(command);
    if (response.kind !== "turn") {
      throw new Error("Expected Guest turn");
    }
    return response.turn;
  }
  function identity() {
    if (busy || poisoned || closed) {
      throw new Error("Worker Guest is unavailable");
    }
    return { incarnation: options.incarnation, sequence: sequence++ };
  }
  return {
    *start() {
      return yield* advance({ ...identity(), action: "start" });
    },
    *resume(outcome: Outcome<V, E>) {
      return yield* advance({ ...identity(), action: "resume", outcome });
    },
    *cancel(reason) {
      return yield* advance({ ...identity(), action: "cancel", reason });
    },
    *close() {
      if (closed) {
        if (shutdown) {
          yield* runtime.fromPromise(() => shutdown!);
        }
        return;
      }
      if (busy) {
        throw new Error("Cannot close Worker Guest during advancement");
      }
      try {
        if (!poisoned) {
          yield* exchange({ ...identity(), action: "close" });
        }
      } finally {
        closed = true;
        options.port.close();
        shutdown ??= Promise.resolve().then(() => options.terminate());
        yield* runtime.fromPromise(() => shutdown!);
      }
    },
  };
}
