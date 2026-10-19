import {
  action,
  createQueue,
  race,
  resource,
  scoped,
  sleep,
  spawn,
  type Operation,
  type Task,
} from "effection";
import { useWorker, type WorkerResource } from "@effectionx/worker";
import type {
  DurableProgramWorkerRequest,
  DurableProgramWorkerResponse,
  DurableProgramWorkerResult,
} from "./durable-worker-protocol.ts";

export type DurableWorker = WorkerResource<
  DurableProgramWorkerRequest,
  DurableProgramWorkerResponse,
  DurableProgramWorkerResult
>;
export interface DurableWorkerLease {
  send(request: DurableProgramWorkerRequest): Operation<DurableProgramWorkerResponse>;
  release(reusable: boolean): Operation<void>;
}
export interface DurableWorkerPoolOptions {
  workerUrl: string | URL;
  name?: string;
  idleTimeoutMs: number;
  onWorkerError?: (error: unknown) => void;
}

interface Entry {
  worker: DurableWorker;
  owner: Task<void>;
  idle: boolean;
  closed: boolean;
  deadline: number;
  wake: ReturnType<typeof createQueue<void, void>>;
  failed: ReturnType<typeof createQueue<unknown, void>>;
}

/** Workers belong to this resource's scope, never to an activation that borrows one. */
export function useDurableWorkerPool(options: DurableWorkerPoolOptions): Operation<{
  acquire(): Operation<DurableWorkerLease>;
}> {
  return resource(function* (provide) {
    const entries = new Set<Entry>();
    const requests = createQueue<
      {
        cancelled: boolean;
        reply: (result: { entry: Entry } | { error: unknown }) => void;
      },
      void
    >();
    let closed = false;
    yield* spawn(function* () {
      while (true) {
        const next = yield* requests.next();
        if (next.done) {
          return;
        }
        const request = next.value;
        if (request.cancelled) {
          continue;
        }
        const available = [...entries].find(
          (entry) => entry.idle && !entry.closed && entry.deadline > Date.now(),
        );
        if (available) {
          available.idle = false;
          available.wake.add();
          request.reply({ entry: available });
          continue;
        }
        // Worker startup is owned by the supervisor. Cancellation of the requester
        // cannot leave an unclaimed, active worker behind.
        const ready = createQueue<{ entry: Entry } | { error: unknown }, void>();
        let entry: Entry | undefined;
        const owner: Task<void> = yield* spawn(function* (): Operation<void> {
          try {
            yield* scoped(function* () {
              const worker = yield* useWorker<
                DurableProgramWorkerRequest,
                DurableProgramWorkerResponse,
                DurableProgramWorkerResult,
                void
              >(options.workerUrl, { type: "module", name: options.name });
              // The task is assigned before worker startup completes.
              entry = {
                worker,
                owner,
                idle: false,
                closed: false,
                deadline: 0,
                wake: createQueue(),
                failed: createQueue(),
              };
              entries.add(entry);
              ready.add({ entry });
              while (!entry.closed) {
                if (entry.idle) {
                  const deadline = entry.deadline;
                  yield* race([entry.wake.next(), sleep(Math.max(0, deadline - Date.now()))]);
                  if (entry.idle && entry.deadline === deadline && Date.now() >= deadline) {
                    entry.closed = true;
                  }
                } else {
                  yield* entry.wake.next();
                }
              }
            });
          } catch (error) {
            if (entry) {
              entry.failed.add(error);
            } else {
              ready.add({ error });
            }
            // Transport failures are observable; the authority decides recovery.
            (
              options.onWorkerError ??
              ((failure) => console.error("Durable worker failed", failure))
            )(error);
          } finally {
            if (entry) {
              entry.closed = true;
              entries.delete(entry);
            }
          }
        });
        const result = yield* ready.next();
        if (result.done) {
          throw new Error("Worker startup ended without a result");
        }
        if (request.cancelled) {
          yield* owner.halt();
        } else {
          request.reply(result.value);
        }
      }
    });
    try {
      yield* provide({
        acquire() {
          return resource<DurableWorkerLease>(function* (provideLease) {
            if (closed) {
              throw new Error("Durable worker pool is closed");
            }
            const result = yield* action<{ entry: Entry } | { error: unknown }>((resolve) => {
              const request = { cancelled: false, reply: resolve };
              requests.add(request);
              return () => {
                request.cancelled = true;
              };
            });
            if ("error" in result) {
              throw result.error;
            }
            const entry = result.entry;
            let released = false;
            function* release(reusable: boolean): Operation<void> {
              if (released) {
                return;
              }
              released = true;
              if (reusable && !entry.closed && !closed) {
                entry.deadline = Date.now() + options.idleTimeoutMs;
                entry.idle = true;
                entry.wake.add();
              } else {
                entry.closed = true;
                entry.wake.add();
                yield* entry.owner.halt();
              }
            }
            try {
              yield* provideLease({
                *send(request) {
                  if (released || entry.closed) {
                    throw new Error("Durable worker lease is closed");
                  }
                  return yield* race([
                    entry.worker.send(request),
                    (function* (): Operation<never> {
                      const failure = yield* entry.failed.next();
                      throw failure.value;
                    })(),
                  ]);
                },
                release,
              });
            } finally {
              yield* release(false);
            }
          });
        },
      });
    } finally {
      closed = true;
    }
  });
}
