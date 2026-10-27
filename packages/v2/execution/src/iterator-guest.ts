import type { Work } from "@standard-durability/core";
import type { Guest, Turn } from "./contracts.ts";
import type { IteratorGuestState } from "./types.ts";

/**
 * Own an authored iterator independently of the native runner.
 * Only start/resume advance it. Physical resources belong to the acquiring host;
 * close discards the iterator without calling return/throw or running its finally.
 */
export function createIteratorGuest<Result, Request>(
  work: Work<Result, Request>,
): Guest<Result, Request, never> {
  let state: IteratorGuestState = "new";
  let iterator: Iterator<Request, Result, unknown> | undefined;

  function advance(step: () => IteratorResult<Request, Result>): Turn<Result, Request> {
    state = "advancing";
    try {
      const next = step();
      if (next.done) {
        state = "completed";
        iterator = undefined;
        return { kind: "completed", value: next.value };
      }
      state = "suspended";
      return { kind: "suspended", request: next.value };
    } catch (error) {
      state = "failed";
      iterator = undefined;
      throw error;
    }
  }

  return {
    *start() {
      if (state !== "new") {
        throw new Error(`Cannot start guest while ${state}`);
      }
      return advance(() => {
        iterator = work()[Symbol.iterator]();
        return iterator.next();
      });
    },
    *resume(outcome) {
      if (state !== "suspended" || !iterator) {
        throw new Error(`Cannot resume guest while ${state}`);
      }
      const current = iterator;
      return advance(() => {
        if (outcome.ok) {
          return current.next(outcome.value);
        }
        if (!current.throw) {
          throw outcome.error;
        }
        return current.throw(outcome.error);
      });
    },
    *close() {
      if (state === "advancing") {
        throw new Error("Cannot close guest while advancing");
      }
      state = "closed";
      iterator = undefined;
    },
  };
}
