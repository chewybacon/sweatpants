import type { Operation } from "@standard-durability/core";
import type { Runtime } from "@sweatpan.ts/runtime";
import type { GuestWorkerOptions } from "./contracts.ts";
import { createGuestCommandReceiver } from "./receiver.ts";
import { decodeCommand } from "./wire.ts";

/**
 * Own an acquired Guest and process serialized commands in this native scope.
 * Normal close acknowledges physical disposal. Native shutdown also disposes without
 * logical cancellation. Dedicated channel; transport/decoding failure ends this server.
 */
export function* serveGuestWorker<R, Q, Y, V, E>(
  runtime: Runtime<Y>,
  options: GuestWorkerOptions<R, Q, Y, V, E>,
): Operation<void, Y> {
  yield* runtime.composition.ensure(function* () {
    options.port.close();
  });
  const guest = yield* options.acquire();
  yield* runtime.composition.ensure(() => guest.close());
  const receiver = createGuestCommandReceiver(runtime.composition, options.incarnation, guest);
  const incoming = runtime.createSignal<unknown>();
  // Subscribe before attaching callbacks so synchronous arrival cannot be lost.
  const subscription = yield* incoming;
  let failed = false;
  let outstanding = false;
  const failure = () => {
    failed = true;
    incoming.close();
  };
  const message = (event: unknown) => {
    if (failed) {
      return;
    }
    if (!event || typeof event !== "object" || !("data" in event) || outstanding) {
      failure();
      return;
    }
    // Admission precedes buffering; a queued or executing command occupies the slot.
    outstanding = true;
    incoming.send(event.data);
  };
  options.port.addEventListener("message", message);
  options.port.addEventListener("messageerror", failure);
  yield* runtime.composition.ensure(function* () {
    options.port.removeEventListener("message", message);
    options.port.removeEventListener("messageerror", failure);
  });
  options.port.start();
  while (true) {
    const item = yield* subscription.next();
    if (failed || item.done) {
      throw new Error("Guest command channel failed");
    }
    const command = decodeCommand<V, E>(options.codec, item.value);
    const response = yield* receiver.receive(command);
    if (failed) {
      throw new Error("Guest command channel failed");
    }
    // eslint-disable-next-line unicorn/require-post-message-target-origin -- Dedicated MessagePort, not Window.postMessage.
    options.port.postMessage(options.codec.encode(response));
    outstanding = false;
    if (response.kind === "closed" || response.kind === "error") {
      return;
    }
  }
}
