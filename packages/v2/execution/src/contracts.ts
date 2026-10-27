import type { Operation, Outcome, Work } from "@standard-durability/core";

/** A returned boundary; suspension does not imply durable acceptance. */
export type Turn<Result, Request> =
  | { readonly kind: "suspended"; readonly request: Request }
  | { readonly kind: "completed"; readonly value: Result }
  | { readonly kind: "cancelled"; readonly reason: string; readonly failure?: string };

/** A live continuation. Native operations advance it; domain requests are returned as data. */
export interface Guest<Result, Request, Y, Value = unknown, Error = unknown> {
  start(): Operation<Turn<Result, Request>, Y>;
  resume(outcome: Outcome<Value, Error>): Operation<Turn<Result, Request>, Y>;
  /**
   * Optional logical root cancellation. Advances authored cleanup to its next boundary.
   * Repeated calls preserve the current cleanup suspension/terminal boundary. A caught
   * or overridden language return cannot turn cancellation into successful completion.
   */
  cancel?(reason: string): Operation<Turn<Result, Request>, Y>;
  /** Idempotently dispose this incarnation without advancing or unwinding authored code. */
  close(): Operation<void, Y>;
}

/** Acquire a fresh guest and its physical resources without advancing the authored body. */
export type GuestWork<Result, Request, Y, Value = unknown, Error = unknown> = Work<
  Guest<Result, Request, Y, Value, Error>,
  Y
>;
