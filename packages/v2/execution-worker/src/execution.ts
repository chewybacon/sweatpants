import type { Guest } from "@sweatpan.ts/execution";
import type { Runtime } from "@sweatpan.ts/runtime";
import type { WorkerExecution, WorkerExecutionOptions } from "./contracts.ts";
import type { WorkerSession } from "./types.ts";
import { createWorkerSession } from "./guest.ts";

/** Bind checkpoint policy to proxies owned by this pinned placement assembly. */
export function createWorkerExecution<R, Q, Y, V = unknown, E = unknown>(
  runtime: Runtime<Y>,
  options: WorkerExecutionOptions<Y>,
): WorkerExecution<R, Q, Y, V, E> {
  const owned = new WeakMap<Guest<R, Q, Y, V, E>, WorkerSession<R, Q, Y, V, E>>();
  function* open() {
    const placement = yield* options.open();
    const session = yield* createWorkerSession<R, Q, Y, V, E>(runtime, placement);
    owned.set(session.guest, session);
    return session;
  }
  return {
    *acquire() {
      return (yield* open()).guest;
    },
    checkpoints: {
      format: options.checkpointFormat,
      *capture(guest) {
        const session = owned.get(guest);
        if (!session) {
          return undefined;
        }
        return yield* session.capture(options.checkpointFormat);
      },
      *restore(state) {
        const session = yield* open();
        const turn = yield* session.restore(options.checkpointFormat, state);
        return { guest: session.guest, turn };
      },
    },
  };
}
