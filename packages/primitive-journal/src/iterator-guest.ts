import { createGuest, type Guest, type Work } from "@sweatpants/foundation/computation";
import { advance } from "./iterator-turn.ts";

/** A synchronous driver under the shared execution discipline. */
export function createIteratorGuest<T, Request>(work: Work<T, Request>): Guest<T, Request, never> {
  const iterator = work()[Symbol.iterator]();
  return createGuest({
    *start() {
      return advance(iterator);
    },
    *resume(outcome) {
      if (!outcome.ok && !iterator.throw) {
        throw outcome.error;
      }
      const result = outcome.ok ? iterator.next(outcome.value) : iterator.throw!(outcome.error);
      return result.done
        ? { kind: "completed", value: result.value }
        : { kind: "suspended", request: result.value };
    },
    *close() {
      const result = iterator.return?.(undefined);
      if (result && !result.done) {
        throw new Error("Guest finalizers must not yield");
      }
    },
  });
}
