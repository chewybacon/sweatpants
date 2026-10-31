import type { Operation, Outcome } from "@standard-durability/core";
import type { Stream } from "@sweatpan.ts/runtime";

/** Application-defined response frames and cursors; this is not a persistent event log. */
export interface ResponseSubscriptions<Cursor, Frame, Close, Y> {
  /** Acquire in the reader scope. Cursor/source validation belongs to the installed driver. */
  subscribe(cursor: Cursor): Stream<Frame, Close, Y>;
}
/** One concrete elicitation's normalized context and authored answer. */
export interface ElicitationHandler<C, O, E, Y> {
  /** UI/automatic handling in the client scope. Transport validation and reply caching stay outside. */
  handle(context: C): Operation<Outcome<O, E>, Y>;
}
