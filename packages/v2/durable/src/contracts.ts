import type { Operation, Outcome } from "@standard-durability/core";
import type { RestoredGuest } from "@sweatpan.ts/codemode-runtime";

/** Immutable accepted history supplied by a trusted host; receipts identify accepted entries. */
export interface Accepted<Q, V, E> {
  readonly sequence: number;
  readonly receipt: string;
  readonly request: Q;
  readonly outcome: Outcome<V, E>;
}

/** Evaluator state anchored to a program and accepted history prefix. */
export interface Checkpoint<S> {
  readonly program: string;
  readonly format: string;
  /** Number of accepted outcomes already reflected in evaluator state. */
  readonly position: number;
  readonly receipt: string | null;
  readonly state: S;
}

/** Trusted accepted history and an optional acceleration checkpoint. */
export interface RecoveryPlan<Q, V, E, S> {
  readonly history: readonly Accepted<Q, V, E>[];
  readonly checkpoint?: Checkpoint<S>;
}

/** Live recovered continuation owned by the executing scope. */
export interface Recovered<R, Q, Y, V, E> extends RestoredGuest<R, Q, Y, V, E> {
  readonly program: string;
  readonly position: number;
}

/** Scoped recovery hooks; reconstruction never invokes a business handler. */
export interface RecoveryMethods<R, Q, Y, V, E, S> {
  /** Replay accepted Outcomes, or restore through installed checkpoint middleware. */
  recover(plan: RecoveryPlan<Q, V, E, S>): Operation<Recovered<R, Q, Y, V, E>, Y>;
  /** Capture an owned suspended evaluator; undefined means capture is unavailable. */
  checkpoint(
    recovered: Recovered<R, Q, Y, V, E>,
    history: readonly Accepted<Q, V, E>[],
  ): Operation<Checkpoint<S> | undefined, Y>;
}

/** Stable delivery identity for an unanswered journal request. */
export interface PendingRequest<Q> {
  readonly id: string;
  readonly sequence: number;
  readonly request: Q;
}

/** Detached execution state; revision guards activation writes. */
export type JournalSnapshot<R, Q, V, E, S> = {
  readonly program: string;
  readonly revision: number;
  readonly history: readonly Accepted<Q, V, E>[];
  readonly checkpoint?: Checkpoint<S>;
} & (
  | { readonly status: "running"; readonly pending?: PendingRequest<Q> }
  | { readonly status: "completed"; readonly value: R }
);

/** Bound to one execution. Mutations are atomic; revisions reject stale activation writes. */
export interface Journal<R, Q, V, E, S, Y> {
  /** Read current state without acquiring or advancing computation. */
  read(): Operation<JournalSnapshot<R, Q, V, E, S>, Y>;
  /**
   * Commit a pending request and optional checkpoint at the expected revision.
   * Throws on stale revision, divergent pending request or invalid checkpoint anchor.
   */
  park(revision: number, request: Q, checkpoint?: Checkpoint<S>): Operation<PendingRequest<Q>, Y>;
  /**
   * Trusted external-answer acceptance; identical redelivery returns its original
   * entry and conflicting delivery fails. Not an authenticated grant endpoint.
   */
  accept(id: string, outcome: Outcome<V, E>): Operation<Acceptance<Q, V, E>, Y>;
  /** Persist completion at the expected revision; an unanswered request prevents completion. */
  complete(revision: number, value: R): Operation<void, Y>;
}

/** A bounded activation leaves either a pending request or a persisted result. */
export type Activation<R, Q> =
  | { readonly state: "parked"; readonly pending: PendingRequest<Q> }
  | { readonly state: "completed"; readonly value: R };

/** Whether another delivery is permitted after an unresolved attempt. */
export type RetrySafety = "repeatable" | "unsafe";

/** A process-local grant is correlation, not an authenticated wire credential. */
export interface AttemptGrant {
  readonly requestId: string;
  readonly attemptId: string;
  readonly retrySafety: RetrySafety;
}

/** Receipt of accepted history, including acknowledgement of identical redelivery. */
export interface Acceptance<Q, V, E> {
  readonly entry: Accepted<Q, V, E>;
  readonly duplicate: boolean;
}

/** Optional capability for executing effects; external answers need no attempt. */
export interface Attempts<Q, V, E, Y> {
  /**
   * Commit a grant before delivery, or report the current occupied attempt.
   * Replacement compares the explicitly observed grant and requires recorded and
   * current policy to be repeatable. Throws for stale requests, stale replacement
   * or unsafe retry. No timeout implies permission to replace an owner.
   */
  begin(
    requestId: string,
    retrySafety: RetrySafety,
    replace?: AttemptGrant,
  ): Operation<
    | { readonly state: "granted"; readonly grant: AttemptGrant }
    | { readonly state: "occupied"; readonly grant: AttemptGrant },
    Y
  >;
  /**
   * Accept only a current grant's Outcome. Replaced grants throw even after the
   * winner completes. Identical redelivery by the winner returns its original
   * entry; a conflicting Outcome throws. Completion of this operation acknowledges
   * acceptance, not exactly-once execution by an external service.
   */
  settle(grant: AttemptGrant, outcome: Outcome<V, E>): Operation<Acceptance<Q, V, E>, Y>;
}

/** Correlates participant resolution with one registered interaction; not a wire credential. */
export interface ResolutionGrant {
  readonly requestId: string;
  readonly resolutionId: string;
}

/** Registration survives host disposal; invalidation preserves its original reason. */
export type InteractionRegistration =
  | { readonly state: "waiting"; readonly grant: ResolutionGrant }
  | { readonly state: "invalidated"; readonly grant: ResolutionGrant; readonly reason: string };

/** The first committed resolution wins: invalidation cannot erase an accepted answer. */
export type Invalidation<Q, V, E> =
  | { readonly state: "invalidated"; readonly reason: string }
  | { readonly state: "accepted"; readonly acceptance: Acceptance<Q, V, E> };

/** Durable participant registration and resolution without an executing handler attempt. */
export interface Interactions<Q, V, E, Y> {
  /** Register a pending request once, or return its existing registration/invalidation. */
  register(requestId: string): Operation<InteractionRegistration, Y>;
  /** Accept with current authority; identical redelivery is acknowledged, revoked authority rejects. */
  answer(grant: ResolutionGrant, outcome: Outcome<V, E>): Operation<Acceptance<Q, V, E>, Y>;
  /**
   * Atomically invalidate an unanswered interaction. Late answers reject. If an answer
   * already won, return its acceptance instead. This fences replies; it does not
   * inject workflow cancellation or claim that logical cleanup has completed.
   */
  invalidate(grant: ResolutionGrant, reason: string): Operation<Invalidation<Q, V, E>, Y>;
}

/**
 * Proposed alarm scheduling intent, owned by one durable execution.
 * This is data only: constructing it does not persist or install an alarm.
 * The future deadline transition must record it atomically with scope state.
 */
export interface AlarmIntent {
  /** Stable, unique deadline-instance ID within the execution; use a new ID when rescheduling. */
  readonly id: string;
  /** Absolute Unix time in milliseconds, resolved once and retained across replay. */
  readonly dueAt: number;
}
