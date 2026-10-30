import type { Operation, Outcome } from "@standard-durability/core";
import type { Turn } from "@sweatpan.ts/execution";

/** Trusted receiver driver for a single pinned Guest. Transport owns serialization. */
export interface GuestCommandReceiver<R, Q, Y, V, E> {
  /** Reject stale/duplicate/out-of-order or overlapping commands without advancing. */
  receive(command: GuestCommand<V, E>): Operation<GuestResponse<R, Q>, Y>;
}

/** Ordered command for one already-acquired, pinned Guest incarnation. */
export type GuestCommand<V = unknown, E = unknown> = {
  readonly incarnation: string;
  readonly sequence: number;
} & (
  | { readonly action: "start" }
  | { readonly action: "resume"; readonly outcome: Outcome<V, E> }
  | { readonly action: "cancel"; readonly reason: string }
  | { readonly action: "close" }
);

/** Correlated execution response. Errors are transport diagnostics, never authored Outcomes. */
export type GuestResponse<R, Q> = {
  readonly incarnation: string;
  readonly sequence: number;
} & (
  | { readonly kind: "turn"; readonly turn: Turn<R, Q> }
  | { readonly kind: "closed" }
  | { readonly kind: "error"; readonly message: string }
);
