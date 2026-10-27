import type { Operation } from "@standard-durability/core";
import type { Guest, Turn } from "@sweatpan.ts/execution";

/** Restoring returns a boundary; acquiring a fresh Guest remains lazy. */
export interface RestoredGuest<R, Q, Y, V, E> {
  readonly guest: Guest<R, Q, Y, V, E>;
  readonly turn: Turn<R, Q>;
}

/** Optional evaluator capability. Journal positions and acceptance are host-owned. */
export interface CheckpointAdapter<R, Q, Y, V, E, Snapshot> {
  readonly format: string;
  /** Undefined means this adapter does not own this Guest. Does not advance it. */
  capture(guest: Guest<R, Q, Y, V, E>): Operation<Snapshot | undefined, Y>;
  restore(snapshot: Snapshot): Operation<RestoredGuest<R, Q, Y, V, E>, Y>;
}
