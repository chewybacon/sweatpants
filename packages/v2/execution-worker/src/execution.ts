import type { Guest, CheckpointAdapter } from "@sweatpan.ts/execution";
import type { Runtime } from "@sweatpan.ts/runtime";
import type { WorkerExecution, WorkerExecutionOptions } from "./contracts.ts";
import type { WorkerSession } from "./types.ts";
import { createWorkerSession } from "./guest.ts";

/** Acquire pinned proxies for journal replay, with optional evaluator checkpoint support. */
export function createWorkerExecution<R, Q, Y, V = unknown, E = unknown>(
  runtime: Runtime<Y>,
  options: WorkerExecutionOptions<Y>,
): WorkerExecution<R, Q, Y, V, E> {
  const invocation = options.invocation ? Object.freeze({ ...options.invocation }) : undefined;
  const format = options.checkpointFormat;
  const owned = new WeakMap<Guest<R, Q, Y, V, E>, WorkerSession<R, Q, Y, V, E>>();
  function* open() {
    const placement = yield* options.open();
    const session = yield* createWorkerSession<R, Q, Y, V, E>(runtime, placement);
    if (invocation) {
      yield* session.initialize(invocation, format);
    }
    owned.set(session.guest, session);
    return session;
  }
  const checkpoints: CheckpointAdapter<R, Q, Y, V, E, unknown> | undefined =
    format === undefined
      ? undefined
      : {
          format,
          *capture(guest) {
            const session = owned.get(guest);
            if (!session) {
              return undefined;
            }
            return yield* session.capture(format);
          },
          *restore(state) {
            const session = yield* open();
            const turn = yield* session.restore(format, state);
            return { guest: session.guest, turn };
          },
        };
  return {
    *acquire() {
      return (yield* open()).guest;
    },
    checkpoints,
  };
}
