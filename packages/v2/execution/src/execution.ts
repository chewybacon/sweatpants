import type { Composition } from "@standard-durability/core";
import type { Execution, Guest } from "./contracts.ts";

/**
 * Declare a scoped execution API without acquiring or advancing an evaluator.
 * The name identifies its bindings and middleware; use a distinct name for unrelated
 * APIs. A concrete Guest installs directly as the driver in its owning scope.
 */
export function createExecution<R, Q, Y, V = unknown, E = unknown>(
  composition: Composition<Y>,
  name: string,
): Execution<R, Q, Y, V, E> {
  function* missing(): Generator<never, never> {
    throw new Error(`Execution driver is not installed: ${name}`);
  }
  const api = composition.createApi<Required<Guest<R, Q, Y, V, E>>>(name, {
    start: missing,
    resume: missing,
    cancel: missing,
    close: missing,
  });
  const binding = composition.createContext<{ guest: Guest<R, Q, Y, V, E>; active: boolean }>(
    `${name}:owner`,
  );
  return {
    *isInstalled(guest) {
      const current = yield* binding.get();
      return current?.guest === guest && current.active;
    },
    operations: api.operations,
    around: api.around,
    *install(guest) {
      // Own the acquired resource even if driver installation fails.
      const owner = { guest, active: true };
      yield* composition.ensure(function* () {
        owner.active = false;
        yield* guest.close();
      });
      yield* api.install({
        start: () => guest.start(),
        resume: (outcome) => guest.resume(outcome),
        *cancel(reason) {
          if (!guest.cancel) {
            throw new Error("Evaluator does not support logical cancellation");
          }
          return yield* guest.cancel(reason);
        },
        *close() {
          owner.active = false;
          yield* guest.close();
        },
      });
      yield* binding.set(owner);
    },
  };
}
