import { MessageChannel, type MessagePort } from "node:worker_threads";
import { deserialize, serialize } from "node:v8";
import type { DuplexExchangeRig, DuplexExchangeRigOptions } from "./contracts.ts";

type Frame =
  | { kind: "request"; id: number; value: unknown }
  | { kind: "response"; id: number; ok: boolean; value: unknown };

/** Exercise nested reverse calls with real encoded messages; no network/process claims. */
export function createDuplexExchangeRig<L, LR, R, RR>(
  options: DuplexExchangeRigOptions<L, LR, R, RR>,
): DuplexExchangeRig<L, LR, R, RR> {
  const { port1, port2 } = new MessageChannel();
  const controller = new AbortController();
  const tasks = new Set<Promise<void>>();
  const requests: { from: "left" | "right"; id: number; value: unknown }[] = [];
  function endpoint<Incoming, Reply, Outgoing, Response>(
    port: MessagePort,
    name: "left" | "right",
    handle: (request: Incoming, signal: AbortSignal) => Promise<Reply>,
  ) {
    let sequence = 0;
    const pending = new Map<
      number,
      { resolve(value: Response): void; reject(error: unknown): void }
    >();
    port.on("message", (bytes: Uint8Array) => {
      const frame = deserialize(bytes) as Frame;
      if (frame.kind === "response") {
        const waiter = pending.get(frame.id);
        if (!waiter) {
          return;
        }
        pending.delete(frame.id);
        if (frame.ok) {
          waiter.resolve(frame.value as Response);
        } else {
          waiter.reject(new Error(String(frame.value)));
        }
        return;
      }
      const task = (async () => {
        let response: Frame;
        try {
          const value = await handle(frame.value as Incoming, controller.signal);
          response = { kind: "response", id: frame.id, ok: true, value };
        } catch (error) {
          response = { kind: "response", id: frame.id, ok: false, value: String(error) };
        }
        if (!controller.signal.aborted && (options.deliver?.(name, response.value) ?? true)) {
          port.postMessage(serialize(response));
        }
      })();
      tasks.add(task);
      void task.finally(() => tasks.delete(task)).catch(() => undefined);
    });
    return {
      exchange(request: Outgoing): Promise<Response> {
        if (controller.signal.aborted) {
          return Promise.reject(controller.signal.reason);
        }
        const id = sequence++;
        return new Promise((resolve, reject) => {
          pending.set(id, { resolve, reject });
          try {
            const bytes = serialize({ kind: "request", id, value: request });
            requests.push({ from: name, id, value: deserialize(bytes).value as unknown });
            port.postMessage(bytes);
          } catch (error) {
            pending.delete(id);
            reject(error);
          }
        });
      },
      get pending() {
        return pending.size;
      },
      shutdown() {
        for (const waiter of pending.values()) {
          waiter.reject(controller.signal.reason);
        }
        pending.clear();
        port.close();
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
      left.shutdown();
      right.shutdown();
      await Promise.allSettled([...tasks]);
    },
  };
}
