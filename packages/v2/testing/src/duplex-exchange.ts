import { MessageChannel, type MessagePort } from "node:worker_threads";
import { deserialize, serialize } from "node:v8";
import { createConnection, type Connection, type Transport } from "@sweatpan.ts/connection";
import type { Runtime, RuntimeExecution } from "@sweatpan.ts/runtime";
import type { DuplexExchangeRig, DuplexExchangeRigOptions } from "./contracts.ts";

/** Real encoded peers using the production connection; this fixture owns concurrent handler tasks. */
export function createDuplexExchangeRig<L, LR, R, RR, Y>(
  runtime: Runtime<Y>,
  options: DuplexExchangeRigOptions<L, LR, R, RR>,
): DuplexExchangeRig<L, LR, R, RR> {
  const { port1, port2 } = new MessageChannel();
  const controller = new AbortController();
  const tasks = new Set<RuntimeExecution<unknown>>();
  const requests: { from: "left" | "right"; id: number; value: unknown }[] = [];
  const codec = { encode: serialize, decode: (bytes: Uint8Array) => deserialize(bytes) as unknown };
  function track<T>(task: RuntimeExecution<T>) {
    tasks.add(task);
    void task.result.finally(() => tasks.delete(task)).catch(() => undefined);
    return task;
  }
  function endpoint<Incoming, Reply, Outgoing, Response>(
    port: MessagePort,
    name: "left" | "right",
    handle: (request: Incoming, signal: AbortSignal) => Promise<Reply>,
  ) {
    let pending = 0;
    let ready!: (connection: Connection<Y>) => void;
    let unavailable!: (error: unknown) => void;
    const connected = new Promise<Connection<Y>>((resolve, reject) => {
      ready = resolve;
      unavailable = reject;
    });
    void connected.catch(() => undefined);
    const transport: Transport = {
      addEventListener: port.addEventListener.bind(port),
      removeEventListener: port.removeEventListener.bind(port),
      start: () => port.start(),
      close: () => port.close(),
      postMessage(bytes) {
        const frame = deserialize(bytes) as { kind: string; id: number; value: unknown };
        if (frame.kind === "request") {
          requests.push({ from: name, id: frame.id, value: frame.value });
        }
        if (frame.kind !== "response" || (options.deliver?.(name, frame.value) ?? true)) {
          port.postMessage(bytes);
        }
      },
    };
    const server = track(
      runtime.start(function* () {
        const connection = yield* createConnection(runtime, {
          transport,
          codec,
          failure: controller.signal,
        });
        ready(connection);
        while (true) {
          const incoming = yield* connection.receive();
          track(
            runtime.start(() =>
              runtime.withSignal(connection.failure, function* () {
                yield* runtime.composition.catchError(
                  function* () {
                    const reply = yield* runtime.fromPromise((signal) =>
                      handle(incoming.value as Incoming, signal),
                    );
                    yield* incoming.respond(reply);
                  },
                  function* (error) {
                    yield* incoming.reject(error instanceof Error ? error.message : String(error));
                  },
                );
              }),
            ),
          );
        }
      }),
    );
    void server.result.catch(unavailable);
    return {
      async exchange(value: Outgoing): Promise<Response> {
        pending++;
        try {
          const connection = await connected;
          return (await track(runtime.start(() => connection.exchange(value))).result) as Response;
        } finally {
          pending--;
        }
      },
      get pending() {
        return pending;
      },
    };
  }
  const left = endpoint<L, LR, R, RR>(port1, "left", options.left);
  const right = endpoint<R, RR, L, LR>(port2, "right", options.right);
  return {
    left,
    right,
    requests,
    async close() {
      controller.abort(new Error("Connection lost"));
      await Promise.allSettled([...tasks].map((task) => task.result));
    },
  };
}
