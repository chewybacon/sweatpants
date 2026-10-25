import type { Guest, Outcome, Work } from "@sweatpants/foundation/computation";
import { advance } from "./iterator-turn.ts";

/** A fresh synchronous computation cursor; disposal is not logical cancellation. */
export function createIteratorGuest<T, Request>(work: Work<T, Request>): Guest<T, Request, never> {
  const iterator = work()[Symbol.iterator]();
  let state: "new" | "suspended" | "completed" | "closed" = "new";
  function accept(result: IteratorResult<Request, T>) {
    state = result.done ? "completed" : "suspended";
    return result.done
      ? { kind: "completed" as const, value: result.value }
      : { kind: "suspended" as const, request: result.value };
  }
  return {
    *start() {
      if (state !== "new") {
        throw new Error("Guest already started");
      }
      const turn = advance(iterator);
      state = turn.kind;
      return turn;
    },
    *resume(outcome: Outcome<unknown, unknown>) {
      if (state !== "suspended") {
        throw new Error("Guest is not suspended");
      }
      if (outcome.ok) {
        return accept(iterator.next(outcome.value));
      }
      if (!iterator.throw) {
        throw outcome.error;
      }
      return accept(iterator.throw(outcome.error));
    },
    *close() {
      if (state === "closed") {
        return;
      }
      state = "closed";
      const result = iterator.return?.(undefined);
      if (result && !result.done) {
        throw new Error("Guest finalizers must not yield");
      }
    },
  };
}
