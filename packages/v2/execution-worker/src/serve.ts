import type { Operation } from "@standard-durability/core";
import { createConnection } from "@sweatpan.ts/connection";
import type { Runtime } from "@sweatpan.ts/runtime";
import type { GuestWorkerOptions } from "./contracts.ts";
import { createGuestCommandReceiver } from "./receiver.ts";
import { decodeCommand } from "./wire.ts";

/** Own a pinned Guest and serve sequential advancement over a shared connection. */
export function* serveGuestWorker<R, Q, Y, V, E>(
  runtime: Runtime<Y>,
  options: GuestWorkerOptions<R, Q, Y, V, E>,
): Operation<void, Y> {
  yield* runtime.composition.ensure(function* () {
    options.port.close();
  });
  const receiver = yield* createGuestCommandReceiver(runtime.composition, options);
  const connection = yield* createConnection(runtime, {
    transport: options.port,
    codec: options.codec,
    failure: new AbortController().signal,
    maxIncoming: 1,
  });
  while (true) {
    const incoming = yield* connection.receive();
    const result = yield* runtime.composition.catchError(
      function* () {
        const command = decodeCommand<V, E>(incoming.value);
        const response = yield* receiver.receive(command);
        return { ok: true as const, response, closed: command.action === "close" };
      },
      function* (error) {
        return {
          ok: false as const,
          message: error instanceof Error ? error.message : String(error),
        };
      },
    );
    if (!result.ok) {
      yield* incoming.reject(result.message);
      return;
    }
    // Publication failures are connection failures; never attempt a second reply.
    yield* incoming.respond(result.response);
    if (result.closed) {
      return;
    }
  }
}
