import type { Api, Composition, Operation, OperationMiddleware } from "@standard-durability/core";
import type { GuestWork } from "@sweatpan.ts/execution";
import type { CheckpointAdapter, RestoredGuest } from "@sweatpan.ts/codemode-runtime";
import type { Accepted, Checkpoint, RecoveryMethods, RecoveryPlan } from "./contracts.ts";

function validate<Q, V, E, S>(program: string, plan: RecoveryPlan<Q, V, E, S>) {
  const receipts = new Set<string>();
  for (const [index, entry] of plan.history.entries()) {
    if (entry.sequence !== index || !entry.receipt || receipts.has(entry.receipt)) {
      throw new Error("Invalid accepted history");
    }
    receipts.add(entry.receipt);
  }
  const saved = plan.checkpoint;
  if (
    saved &&
    (saved.program !== program ||
      !Number.isSafeInteger(saved.position) ||
      saved.position < 0 ||
      saved.position > plan.history.length ||
      saved.receipt !== (saved.position === 0 ? null : plan.history[saved.position - 1]?.receipt))
  ) {
    throw new Error("Checkpoint does not match accepted history");
  }
}

function* replay<R, Q, Y, V, E>(
  initial: RestoredGuest<R, Q, Y, V, E>,
  history: readonly Accepted<Q, V, E>[],
  position: number,
  matches: (actual: Q, accepted: Q) => boolean,
): Operation<RestoredGuest<R, Q, Y, V, E>, Y> {
  let turn = initial.turn;
  for (const entry of history.slice(position)) {
    if (turn.kind !== "suspended" || !matches(turn.request, entry.request)) {
      throw new Error(`Replay request mismatch at ${entry.sequence}`);
    }
    turn = yield* initial.guest.resume(entry.outcome);
  }
  return { guest: initial.guest, turn };
}

/** Replay is the default. No handler is called during reconstruction. Scope owns disposal. */
export function createRecovery<R, Q, Y, V, E, S = unknown>(
  composition: Composition<Y>,
  options: {
    readonly name: string;
    readonly program: string;
    readonly acquire: GuestWork<R, Q, Y, V, E>;
    readonly matches: (actual: Q, accepted: Q) => boolean;
  },
): Api<RecoveryMethods<R, Q, Y, V, E, S>, Y> {
  return composition.createApi<RecoveryMethods<R, Q, Y, V, E, S>>(options.name, {
    *recover(plan) {
      validate(options.program, plan);
      const guest = yield* options.acquire();
      yield* composition.ensure(() => guest.close());
      const turn = yield* guest.start();
      const restored = yield* replay({ guest, turn }, plan.history, 0, options.matches);
      return { ...restored, program: options.program, position: plan.history.length };
    },
    *checkpoint() {
      return undefined;
    },
  });
}

/** Unsupported formats delegate before acquisition. Errors from a supported restore propagate. */
export function createCheckpointMiddleware<R, Q, Y, V, E, S>(
  composition: Composition<Y>,
  options: {
    readonly program: string;
    readonly adapter: CheckpointAdapter<R, Q, Y, V, E, S>;
    readonly matches: (actual: Q, accepted: Q) => boolean;
  },
): OperationMiddleware<RecoveryMethods<R, Q, Y, V, E, S>> {
  const { program, adapter, matches } = options;
  return {
    *recover([plan], next) {
      validate(program, plan);
      const saved = plan.checkpoint;
      if (!saved || saved.format !== adapter.format) {
        return yield* next(plan);
      }
      const restored = yield* adapter.restore(saved.state);
      yield* composition.ensure(() => restored.guest.close());
      const result = yield* replay(restored, plan.history, saved.position, matches);
      return { ...result, program, position: plan.history.length };
    },
    *checkpoint([recovered, history], next) {
      validate(program, { history });
      if (recovered.program !== program || recovered.position !== history.length) {
        throw new Error("Checkpoint position differs from accepted history");
      }
      if (recovered.turn.kind !== "suspended") {
        return yield* next(recovered, history);
      }
      const state = yield* adapter.capture(recovered.guest);
      if (state === undefined) {
        return yield* next(recovered, history);
      }
      return {
        program,
        format: adapter.format,
        position: history.length,
        receipt: history.length ? history[history.length - 1]!.receipt : null,
        state,
      } satisfies Checkpoint<S>;
    },
  };
}
