import type { Operation, Outcome } from "@standard-durability/core";
import type { Guest, Turn } from "@sweatpan.ts/execution";
import { createConnection } from "@sweatpan.ts/connection";
import type { Runtime } from "@sweatpan.ts/runtime";
import type { WorkerGuestOptions } from "./contracts.ts";
import type { GuestCommand, WorkerSession } from "./types.ts";
import { decodeTurn } from "./wire.ts";

/** Acquire a remote Guest connection in the invoking scope; assembly registers Guest disposal. */
export function* createWorkerSession<R, Q, Y, V = unknown, E = unknown>(
  runtime: Runtime<Y>,
  options: WorkerGuestOptions,
): Operation<WorkerSession<R, Q, Y, V, E>, Y> {
  let shutdown: Promise<void> | undefined;
  function terminate() {
    return (shutdown ??= Promise.resolve().then(() => options.terminate()));
  }
  // Acquisition failure must also release a worker that assembly already started.
  yield* runtime.composition.ensure(() => runtime.fromPromise(terminate));
  const connection = yield* createConnection(runtime, {
    transport: options.port,
    codec: options.codec,
    failure: options.failure,
    maxIncoming: 0,
  });
  let sequence = 0;
  let busy = false;
  let poisoned = false;
  let closed = false;
  function* exchange(command: GuestCommand<V, E>): Operation<unknown, Y> {
    if (busy || poisoned || closed) {
      throw new Error("Worker Guest is unavailable");
    }
    busy = true;
    let finished = false;
    try {
      const response = yield* connection.exchange(command);
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
    try {
      const response = yield* exchange(command);
      return decodeTurn<R, Q>(response);
    } catch (error) {
      poisoned = true;
      throw error;
    }
  }
  function identity() {
    if (busy || poisoned || closed) {
      throw new Error("Worker Guest is unavailable");
    }
    return { incarnation: options.incarnation, sequence: sequence++ };
  }
  const guest: Guest<R, Q, Y, V, E> = {
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
        yield* runtime.fromPromise(terminate);
        return;
      }
      if (busy) {
        throw new Error("Cannot close Worker Guest during advancement");
      }
      try {
        if (!poisoned) {
          const response = yield* exchange({ ...identity(), action: "close" });
          if (response !== undefined) {
            throw new Error("Unexpected Guest close response");
          }
        }
      } finally {
        closed = true;
        connection.close();
        yield* runtime.fromPromise(terminate);
      }
    },
  };
  return {
    guest,
    *capture(format) {
      return yield* exchange({ ...identity(), action: "capture", format });
    },
    *restore(format, state) {
      return yield* advance({ ...identity(), action: "restore", format, state });
    },
  };
}

/** Acquire one serialized Guest. Its scope owns connection and remote termination. */
export function* createWorkerGuest<R, Q, Y, V = unknown, E = unknown>(
  runtime: Runtime<Y>,
  options: WorkerGuestOptions,
): Operation<Guest<R, Q, Y, V, E>, Y> {
  const session = yield* createWorkerSession<R, Q, Y, V, E>(runtime, options);
  return session.guest;
}
