import type { Operation } from "@standard-durability/core";
import type { GuestCommand, GuestResponse } from "@sweatpan.ts/execution";

/** Trusted receiver driver for a single pinned Guest. Transport owns serialization. */
export interface GuestCommandReceiver<R, Q, Y, V, E> {
  /** Reject stale/duplicate/out-of-order or overlapping commands without advancing. */
  receive(command: GuestCommand<V, E>): Operation<GuestResponse<R, Q>, Y>;
}
