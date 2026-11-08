import type { Latch, ProtocolReply, ProtocolRequest, ProtocolRig } from "./contracts.ts";

export function createLatch<T>(): Latch<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

/** A scripted in-process peer; requests remain pending until replied to or aborted. */
export function createProtocolRig(): ProtocolRig {
  const requests: ProtocolRequest[] = [];
  const aborted: string[] = [];
  const pending = new Map<
    string,
    {
      reply(value: ProtocolReply): void;
      fail(error: Error): void;
    }
  >();
  const waiting: { count: number; latch: Latch<void> }[] = [];
  function take(id: string) {
    const request = pending.get(id);
    if (!request) {
      throw new Error(`No pending request: ${id}`);
    }
    return request;
  }
  return {
    requests,
    aborted,
    send(request, signal) {
      if (pending.has(request.id)) {
        throw new Error(`Duplicate pending request: ${request.id}`);
      }
      return new Promise((resolve, reject) => {
        function finish() {
          pending.delete(request.id);
          signal.removeEventListener("abort", abort);
        }
        function abort() {
          aborted.push(request.id);
          finish();
          reject(new Error("Protocol request aborted"));
        }
        pending.set(request.id, {
          reply(value) {
            finish();
            resolve(value);
          },
          fail(error) {
            finish();
            reject(error);
          },
        });
        signal.addEventListener("abort", abort, { once: true });
        requests.push({ ...request });
        for (const entry of waiting) {
          if (requests.length >= entry.count) {
            entry.latch.resolve();
          }
        }
        if (signal.aborted) {
          abort();
        }
      });
    },
    waitForRequests(count) {
      if (requests.length >= count) {
        return Promise.resolve();
      }
      const latch = createLatch<void>();
      waiting.push({ count, latch });
      return latch.promise;
    },
    reply(id, reply) {
      take(id).reply(reply);
    },
    fail(id, error) {
      take(id).fail(error);
    },
  };
}
