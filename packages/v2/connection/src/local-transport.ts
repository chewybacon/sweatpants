import type { Transport } from "./contracts.ts";

/** In-process ordered byte pair. Copy on send and microtask delivery preserve the transport boundary. */
export function createLocalTransport(): readonly [Transport, Transport] {
  function endpoint() {
    const listeners = new Set<(event: unknown) => void>();
    const queued: Uint8Array[] = [];
    let started = false;
    let closed = false;
    let scheduled = false;
    function schedule() {
      if (!started || closed || scheduled || queued.length === 0) {
        return;
      }
      scheduled = true;
      queueMicrotask(() => {
        scheduled = false;
        if (closed) {
          return;
        }
        const batch = queued.splice(0);
        for (const bytes of batch) {
          if (closed) {
            break;
          }
          for (const listener of [...listeners]) {
            listener({ data: bytes });
          }
        }
        schedule();
      });
    }
    return {
      accept(bytes: Uint8Array) {
        if (!closed) {
          queued.push(bytes);
          schedule();
        }
      },
      port(send: (bytes: Uint8Array) => void): Transport {
        return {
          postMessage(bytes) {
            if (closed) {
              throw new Error("Local transport closed");
            }
            send(bytes.slice());
          },
          addEventListener(type, listener) {
            if (type === "message") {
              listeners.add(listener);
            }
          },
          removeEventListener(type, listener) {
            if (type === "message") {
              listeners.delete(listener);
            }
          },
          start() {
            started = true;
            schedule();
          },
          close() {
            closed = true;
            queued.length = 0;
            listeners.clear();
          },
        };
      },
    };
  }
  const left = endpoint();
  const right = endpoint();
  return [left.port(right.accept), right.port(left.accept)];
}
