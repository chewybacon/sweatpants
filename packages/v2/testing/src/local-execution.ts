import { createRecovery } from "@sweatpan.ts/durable";
import { serialize, deserialize } from "node:v8";
import { createLocalExecution } from "@sweatpan.ts/execution-worker";
import type { GuestWork, CheckpointAdapter } from "@sweatpan.ts/execution";
import type { Runtime } from "@sweatpan.ts/runtime";

/** Default hosted test placement. Low-level evaluator tests may still acquire Guests directly. */
export function createHostedExecution<R, Q, Y, V = unknown, E = unknown>(
  runtime: Runtime<Y>,
  options: {
    readonly acquire: GuestWork<R, Q, Y, V, E>;
    readonly checkpoints?: CheckpointAdapter<R, Q, Y, V, E, unknown>;
  },
) {
  return createLocalExecution(runtime, {
    ...options,
    codec: { encode: serialize, decode: (bytes) => deserialize(bytes) as unknown },
  });
}

/** Host-side acquisition keeps scoped grants; execution advances through local bytes by default. */
export function createHostedRecovery<R, Q, Y, V, E, S = unknown>(
  runtime: Runtime<Y>,
  options: {
    readonly name: string;
    readonly program: string;
    readonly acquire: GuestWork<R, Q, Y, V, E>;
    readonly matches: (actual: Q, accepted: Q) => boolean;
  },
) {
  return createRecovery<R, Q, Y, V, E, S>(runtime.composition, {
    ...options,
    *acquire() {
      const acquired = yield* options.acquire();
      let closed = false;
      const guest: typeof acquired = {
        ...acquired,
        *close() {
          if (!closed) {
            closed = true;
            yield* acquired.close();
          }
        },
      };
      yield* runtime.composition.ensure(() => guest.close());
      const local = createHostedExecution(runtime, {
        *acquire() {
          return guest;
        },
      });
      return yield* local.acquire();
    },
  });
}
