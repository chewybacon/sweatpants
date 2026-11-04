import type { Api, Composition } from "@standard-durability/core";
import { createExecution, type GuestWork } from "@sweatpan.ts/execution";
import type { Recovery, RecoveryMethods } from "./contracts.ts";
import { validate, replay } from "./recovery-history.ts";
/** Replay is the default. No handler is called during reconstruction. Scope owns disposal. */
export function createRecovery<R, Q, Y, V, E, S = unknown>(
  composition: Composition<Y>,
  options: {
    readonly name: string;
    readonly program: string;
    readonly acquire: GuestWork<R, Q, Y, V, E>;
    readonly matches: (actual: Q, accepted: Q) => boolean;
  },
): Recovery<R, Q, Y, V, E, S> {
  // Logical cancellation is applied once per live incarnation, not once per activation.
  const cancelled = new WeakSet<object>();
  const execution = createExecution<R, Q, Y, V, E>(composition, `${options.name}:execution`);
  const api: Api<RecoveryMethods<R, Q, Y, V, E, S>, Y> = composition.createApi<
    RecoveryMethods<R, Q, Y, V, E, S>
  >(options.name, {
    operations: {
      *recover(plan) {
        yield* validate(options.program, plan);
        const guest = yield* options.acquire();
        yield* execution.install(guest);
        const turn = yield* execution.operations.start();
        return yield* api.operations.advance(
          { guest, turn, program: options.program, position: 0, receipt: null },
          plan,
        );
      },
      *advance(current, plan) {
        yield* validate(options.program, plan);
        const position = current.position;
        if (
          current.program !== options.program ||
          !Number.isSafeInteger(position) ||
          position < 0 ||
          position > plan.history.end.position
        ) {
          throw new Error("Live Guest differs from accepted history");
        }
        const receipt = position === 0 ? null : (yield* plan.history.at(position - 1))?.receipt;
        if (current.receipt !== receipt) {
          throw new Error("Live Guest differs from accepted history");
        }
        const advanced = yield* replay(
          current,
          execution.operations,
          plan.history,
          position,
          options.matches,
          plan.cancellation,
          cancelled.has(current.guest),
        );
        if (advanced.cancellationApplied) {
          cancelled.add(advanced.guest);
        }
        return {
          guest: advanced.guest,
          turn: advanced.turn,
          program: options.program,
          ...plan.history.end,
        };
      },
      *checkpoint() {
        return undefined;
      },
    },
  });
  return { ...api, execution };
}
