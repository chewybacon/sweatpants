import type { Outcome } from "@standard-durability/core";
import type { Acceptance, ChildLink, JournalSnapshot, RootCancellation } from "./contracts.ts";

/** Trusted assembly binding, deliberately excluded from cloned records. */
export interface ChildBinding {
  readonly program: string;
  readonly outcome: (value: unknown) => Outcome<unknown, unknown>;
}

/** Transaction overlay for code bindings; publication does not copy historical bindings. */
export interface ChildBindings {
  get(id: string): ChildBinding | undefined;
  has(id: string): boolean;
  set(id: string, binding: ChildBinding): void;
}

/** Pure cancellation decision; adapters publish the state and authority changes atomically. */
export interface CancellationTransition<R, Q, S> {
  readonly snapshot: JournalSnapshot<R, Q, S>;
  readonly cancellation: RootCancellation<Q>;
  readonly revoke: boolean;
  readonly childToCancel?: ChildLink;
}

/** Prepared acceptance; an adapter publishes the snapshot before acknowledging acceptance. */
export interface AcceptanceTransition<R, Q, V, E, S> {
  readonly snapshot: JournalSnapshot<R, Q, S>;
  readonly acceptance: Acceptance<Q, V, E>;
}
