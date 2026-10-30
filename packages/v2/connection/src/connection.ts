import type { Operation } from "@standard-durability/core";
import type { Runtime } from "@sweatpan.ts/runtime";
import type { Connection, ConnectionOptions, IncomingExchange } from "./contracts.ts";
import type { Frame, PendingReply } from "./types.ts";
import { decode } from "./wire.ts";

/** Acquire listeners and one private request subscription in the invoking scope. */
export function* createConnection<Y>(
  runtime: Runtime<Y>,
  options: ConnectionOptions,
): Operation<Connection<Y>, Y> {
  const capacity = options.maxIncoming ?? Infinity;
  if (capacity < 0 || (capacity !== Infinity && !Number.isSafeInteger(capacity))) {
    throw new Error("Invalid incoming request capacity");
  }
  const controller = new AbortController();
  const pending = new Map<number, PendingReply>();
  const incoming = runtime.createSignal<IncomingExchange<Y>>();
  const subscription = yield* incoming;
  let sequence = 0;
  let expected = 0;
  let outstanding = 0;
  function fail(error: unknown) {
    if (controller.signal.aborted) {
      return;
    }
    controller.abort(error);
    options.transport.removeEventListener("message", message);
    options.transport.removeEventListener("messageerror", transportFailed);
    options.failure.removeEventListener("abort", disconnected);
    for (const waiter of pending.values()) {
      waiter.reject(error);
    }
    pending.clear();
    incoming.close();
    options.transport.close();
  }
  function send(frame: Frame) {
    controller.signal.throwIfAborted();
    try {
      // eslint-disable-next-line unicorn/require-post-message-target-origin -- Transport is an ordered byte port, not Window.
      options.transport.postMessage(options.codec.encode(frame));
    } catch (error) {
      fail(error);
      throw error;
    }
  }
  function message(event: unknown) {
    if (controller.signal.aborted) {
      return;
    }
    try {
      if (!event || typeof event !== "object" || !("data" in event)) {
        throw new Error("Invalid transport message event");
      }
      const frame = decode(options.codec, event.data);
      if (frame.kind === "response") {
        const waiter = pending.get(frame.id);
        if (!waiter) {
          throw new Error("Mismatched connection response");
        }
        pending.delete(frame.id);
        if (frame.ok) {
          waiter.resolve(frame.value);
        } else {
          waiter.reject(new Error(frame.value as string));
        }
        return;
      }
      if (frame.id !== expected++ || outstanding >= capacity) {
        throw new Error("Unavailable or out-of-order incoming exchange");
      }
      outstanding++;
      let replied = false;
      function* reply(ok: boolean, value: unknown): Operation<void, Y> {
        if (replied) {
          throw new Error("Exchange already answered");
        }
        replied = true;
        send({ kind: "response", id: frame.id, ok, value });
        outstanding--;
      }
      incoming.send({
        value: frame.value,
        respond: (value) => reply(true, value),
        reject: (diagnostic) => reply(false, diagnostic),
      });
    } catch (error) {
      fail(error);
    }
  }
  const transportFailed = () => fail(new Error("Connection transport failed"));
  const disconnected = () => fail(options.failure.reason);
  const close = () => fail(new Error("Connection closed"));
  yield* runtime.composition.ensure(function* () {
    close();
  });
  options.transport.addEventListener("message", message);
  options.transport.addEventListener("messageerror", transportFailed);
  options.failure.addEventListener("abort", disconnected, { once: true });
  if (options.failure.aborted) {
    disconnected();
  }
  controller.signal.throwIfAborted();
  options.transport.start();
  return {
    failure: controller.signal,
    close,
    *receive() {
      controller.signal.throwIfAborted();
      const item = yield* subscription.next();
      controller.signal.throwIfAborted();
      if (item.done) {
        throw new Error("Connection closed");
      }
      return item.value;
    },
    *exchange(value) {
      return yield* runtime.fromPromise(
        (signal) =>
          new Promise((resolve, reject) => {
            const abort = () => fail(signal.reason);
            const clean = () => signal.removeEventListener("abort", abort);
            signal.addEventListener("abort", abort, { once: true });
            if (signal.aborted || controller.signal.aborted) {
              clean();
              reject(signal.aborted ? signal.reason : controller.signal.reason);
              return;
            }
            const id = sequence++;
            pending.set(id, {
              resolve(value) {
                clean();
                resolve(value);
              },
              reject(error) {
                clean();
                reject(error);
              },
            });
            try {
              send({ kind: "request", id, value });
            } catch (error) {
              fail(error);
            }
          }),
      );
    },
  };
}
