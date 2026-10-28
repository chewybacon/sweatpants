import type { Work } from "@standard-durability/core";
import type { Guest, Turn } from "./contracts.ts";
import type { IteratorGuestState } from "./types.ts";

/**
 * Own an authored iterator independently of the native runner.
 * Start/resume and explicit cancel advance it. Physical resources belong to the acquiring host;
 * close discards the iterator without calling return/throw or running its finally.
 * Cancellation already entered through cancel is idempotent.
 *
 * @remarks Arbitrary JavaScript finally is not guaranteed to drain on cancellation.
 * The first cancel calls iterator.return(); if already suspended inside finally, that
 * return can skip the rest of the block. The standard iterator API cannot report this
 * phase. Normal finally behavior on return/exception is unchanged. Use createScopedGuest
 * with LogicalScope.ensure for registered, recoverable logical cleanup. Host disposal
 * deliberately does not call return() and therefore does not initiate finally cleanup.
 */
export function createIteratorGuest<Result, Request>(
  work: Work<Result, Request>,
): Guest<Result, Request, never> {
  let state: IteratorGuestState = "new";
  let cancellation: string | undefined;
  let boundary: Turn<Result, Request> | undefined;
  let iterator: Iterator<Request, Result, unknown> | undefined;

  function advance(step: () => IteratorResult<Request, Result>): Turn<Result, Request> {
    state = "advancing";
    try {
      const next = step();
      if (next.done) {
        state = "completed";
        iterator = undefined;
        if (cancellation !== undefined) {
          state = "cancelled";
          return (boundary = { kind: "cancelled", reason: cancellation });
        }
        return (boundary = { kind: "completed", value: next.value });
      }
      state = "suspended";
      return (boundary = { kind: "suspended", request: next.value });
    } catch (error) {
      state = "failed";
      iterator = undefined;
      if (cancellation !== undefined) {
        state = "cancelled";
        return (boundary = {
          kind: "cancelled",
          reason: cancellation,
          failure: error instanceof Error ? error.message : String(error),
        });
      }
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
    *cancel(reason) {
      if (state === "closed" || state === "advancing" || state === "failed") {
        throw new Error(`Cannot cancel guest while ${state}`);
      }
      if (cancellation !== undefined && boundary) {
        return boundary;
      }
      if (state !== "suspended" || !iterator?.return) {
        throw new Error("Guest cancellation requires a suspended return-capable iterator");
      }
      cancellation = reason;
      const current = iterator;
      // The return value is ignored: cancellation owns terminal disposition.
      return advance(() => current.return!());
    },
    *close() {
      if (state === "advancing") {
        throw new Error("Cannot close guest while advancing");
      }
      state = "closed";
      iterator = undefined;
      boundary = undefined;
    },
  };
}
