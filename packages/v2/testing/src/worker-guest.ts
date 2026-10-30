import type { Transport } from "@sweatpan.ts/connection";
import { MessageChannel } from "node:worker_threads";
import { serialize, deserialize } from "node:v8";
import { createWorkerGuest, serveGuestWorker } from "@sweatpan.ts/execution-worker";
import type { RuntimeExecution } from "@sweatpan.ts/runtime";
import type { WorkerGuestRig, WorkerGuestRigOptions } from "./contracts.ts";

/** In-process MessageChannel peer with real byte encoding; not a subprocess/crash rig. */
export function createWorkerGuestRig<R, Q, Y, V = unknown, E = unknown>(
  options: WorkerGuestRigOptions<R, Q, Y, V, E>,
): WorkerGuestRig<R, Q, Y, V, E> {
  const tasks: RuntimeExecution<void>[] = [];
  const commands: WorkerGuestRig<R, Q, Y, V, E>["commands"][number][] = [];
  const responses: WorkerGuestRig<R, Q, Y, V, E>["responses"][number][] = [];
  let terminations = 0;
  const ports = new Map<string, MessageChannel>();
  const codec = { encode: serialize, decode: (bytes: Uint8Array) => deserialize(bytes) as unknown };
  const rig: WorkerGuestRig<R, Q, Y, V, E> = {
    commands,
    responses,
    get terminations() {
      return terminations;
    },
    *acquire() {
      const incarnation = `worker-${tasks.length}`;
      const channel = new MessageChannel();
      ports.set(incarnation, channel);
      const { port1, port2 } = channel;
      const serverPort: Transport = {
        addEventListener: port2.addEventListener.bind(port2),
        removeEventListener: port2.removeEventListener.bind(port2),
        start: () => port2.start(),
        close: () => port2.close(),
        postMessage(bytes) {
          const response = deserialize(bytes) as WorkerGuestRig<R, Q, Y, V, E>["responses"][number];
          responses.push(response);
          const selected = options.response ? options.response(response) : response;
          if (selected !== undefined) {
            port2.postMessage(codec.encode(selected));
          }
        },
      };
      const clientPort: Transport = {
        addEventListener: port1.addEventListener.bind(port1),
        removeEventListener: port1.removeEventListener.bind(port1),
        start: () => port1.start(),
        close: () => port1.close(),
        postMessage(bytes) {
          const frame = deserialize(bytes) as {
            value: WorkerGuestRig<R, Q, Y, V, E>["commands"][number];
          };
          const command = frame.value;
          commands.push(command);
          port1.postMessage(
            codec.encode({ ...frame, value: options.command ? options.command(command) : command }),
          );
        },
      };
      const task = options.runtime.start(() =>
        serveGuestWorker(options.runtime, {
          incarnation,
          port: serverPort,
          codec,
          acquire: options.acquire,
        }),
      );
      tasks.push(task);
      void task.result.catch(() => undefined);
      return yield* createWorkerGuest<R, Q, Y, V, E>(options.runtime, {
        incarnation,
        port: clientPort,
        codec,
        failure: options.failure ?? new AbortController().signal,
        async terminate() {
          terminations++;
          port1.close();
          await task.cancel();
          port2.close();
        },
      });
    },
    inject(incarnation, command) {
      const channel = ports.get(incarnation);
      if (!channel) {
        return Promise.reject(new Error("Unknown worker incarnation"));
      }
      return new Promise<void>((resolve) => {
        channel.port2.addEventListener("message", () => resolve(), { once: true });
        channel.port1.postMessage(codec.encode(command));
      });
    },
    async close() {
      await Promise.all(tasks.map((task) => task.cancel()));
    },
  };
  return rig;
}
