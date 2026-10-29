import type { Composition, Operation } from "@standard-durability/core";
import {
  advanceJournal,
  type Journal,
  type Recovered,
  type RecoveryMethods,
  type Recovery,
} from "@sweatpan.ts/durable";
import type { Hosting } from "./contracts.ts";

/**
 * Install per-run Guest retention in the executing scope. Each run owns a separate
 * continuation and native scope; immediate deliveries reconcile accepted history
 * without reacquiring. Return, failure and cancellation join that scope's cleanup.
 * If scoped middleware closes or hides the driver, the next activation reacquires.
 * Checkpoint/replay middleware still selects initial recovery. This is composable
 * activation policy, not a journal lease or an evaluator-owned record implementation.
 */
export function installGuestRetention<R, Q, V, E, S, Y>(
  composition: Composition<Y>,
  host: Hosting<R, Q, V, E, Y>,
  recovery: Recovery<R, Q, Y, V, E, S>,
  journal: Journal<R, Q, V, E, S, Y>,
): Operation<void, Y> {
  return host.around({
    run(args, next) {
      return composition.scoped(function* () {
        let current: Recovered<R, Q, Y, V, E> | undefined;
        const driver: RecoveryMethods<R, Q, Y, V, E, S> = {
          ...recovery.operations,
          *recover(plan) {
            current =
              current && (yield* recovery.execution.isInstalled(current.guest))
                ? yield* recovery.operations.advance(current, plan)
                : yield* recovery.operations.recover(plan);
            return current;
          },
        };
        yield* host.around({
          *activate() {
            while (true) {
              const activation = yield* advanceJournal(driver, journal);
              if (activation) {
                return activation;
              }
            }
          },
        });
        return yield* next(...args);
      });
    },
  });
}
