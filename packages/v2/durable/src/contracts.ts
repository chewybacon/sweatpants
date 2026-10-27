import type { Operation, Outcome } from "@standard-durability/core";
import type { RestoredGuest } from "@sweatpan.ts/codemode-runtime";

/** Immutable accepted history supplied by a trusted host; receipts identify accepted entries. */
export interface Accepted<Q, V, E> {
  readonly sequence: number;
  readonly receipt: string;
  readonly request: Q;
  readonly outcome: Outcome<V, E>;
}

export interface Checkpoint<S> {
  readonly program: string;
  readonly format: string;
  /** Number of accepted outcomes already reflected in evaluator state. */
  readonly position: number;
  readonly receipt: string | null;
  readonly state: S;
}

export interface RecoveryPlan<Q, V, E, S> {
  readonly history: readonly Accepted<Q, V, E>[];
  readonly checkpoint?: Checkpoint<S>;
}

export interface Recovered<R, Q, Y, V, E> extends RestoredGuest<R, Q, Y, V, E> {
  readonly program: string;
  readonly position: number;
}

export interface RecoveryMethods<R, Q, Y, V, E, S> {
  recover(plan: RecoveryPlan<Q, V, E, S>): Operation<Recovered<R, Q, Y, V, E>, Y>;
  checkpoint(
    recovered: Recovered<R, Q, Y, V, E>,
    history: readonly Accepted<Q, V, E>[],
  ): Operation<Checkpoint<S> | undefined, Y>;
}
