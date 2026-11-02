import type { Work } from "@standard-durability/core";
import type { PullStreamScope, Stream } from "./contracts.ts";

/**
 * One owner, one controlling subscription, no queue or producer task. The factory
 * runs on acquisition; its operation advances only on next(). Repeated acquisition
 * and concurrent next calls reject. Completion and thrown failures are retained.
 * Owner exit invalidates the handle and releases the source closure. Each new run
 * needs a fresh stream. Source operations own their resources through that owner.
 * Native interruption requires exiting the owner; this helper cannot join or cancel
 * an arbitrary in-flight operation. Guest host disposal discards the whole incarnation.
 */
export function createPullStream<T, Close, Y, OwnerY>(
  owner: PullStreamScope<OwnerY>,
  factory: () => Work<IteratorResult<T, Close>, Y>,
): Stream<T, Close, Y | OwnerY> {
  let acquired = false;
  return {
    *[Symbol.iterator]() {
      if (acquired) {
        throw new Error("Pull stream already acquired");
      }
      acquired = true;
      let active = true;
      let reading = false;
      let terminal: IteratorReturnResult<Close> | undefined;
      let failure: { error: unknown } | undefined;
      let next: Work<IteratorResult<T, Close>, Y> | undefined;
      yield* owner.ensure(function* () {
        active = false;
        next = undefined;
        terminal = undefined;
        failure = undefined;
      });
      if (!active) {
        throw new Error("Pull stream scope exited");
      }
      next = factory();
      return {
        *next() {
          if (!active) {
            throw new Error("Pull stream scope exited");
          }
          if (reading) {
            throw new Error("Concurrent subscription reads are unsupported");
          }
          if (failure) {
            throw failure.error;
          }
          if (terminal) {
            return terminal;
          }
          reading = true;
          try {
            const item = yield* next!();
            if (!active) {
              throw new Error("Pull stream scope exited");
            }
            if (item.done) {
              terminal = item;
              next = undefined;
            }
            return item;
          } catch (error) {
            failure = { error };
            next = undefined;
            throw error;
          } finally {
            reading = false;
          }
        },
      };
    },
  };
}
