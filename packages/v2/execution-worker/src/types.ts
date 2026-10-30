import type { Operation, Outcome } from "@standard-durability/core";
import type { Guest, Turn } from "@sweatpan.ts/execution";

/** Trusted receiver driver for a single pinned Guest. Transport owns serialization. */
export interface GuestCommandReceiver<Y, V, E> {
  /** Reject stale/duplicate/out-of-order or overlapping commands without advancing. */
  receive(command: GuestCommand<V, E>): Operation<unknown, Y>;
}

/** Ordered command for one already-acquired, pinned Guest incarnation. */
export type GuestCommand<V = unknown, E = unknown> = {
  readonly incarnation: string;
  readonly sequence: number;
} & (
  | { readonly action: "start" }
  // Deliver an answer to a live Guest, including accepted answers during journal replay.
  | { readonly action: "resume"; readonly outcome: Outcome<V, E> }
  | { readonly action: "cancel"; readonly reason: string }
  | { readonly action: "capture"; readonly format: string }
  | { readonly action: "restore"; readonly format: string; readonly state: unknown }
  | { readonly action: "close" }
);

/** Internal wire operations; capture/restore require an explicitly configured server adapter. */
export interface WorkerSession<R, Q, Y, V, E> {
  readonly guest: Guest<R, Q, Y, V, E>;
  capture(format: string): Operation<unknown, Y>;
  restore(format: string, state: unknown): Operation<Turn<R, Q>, Y>;
}
