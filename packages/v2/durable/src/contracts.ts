import type { Api, Operation, Outcome } from "@standard-durability/core";
import type { Execution, ScopeBoundary, RestoredGuest } from "@sweatpan.ts/execution";

/** Immutable accepted history supplied by a trusted host; receipts identify accepted entries. */
export interface Accepted<Q, V, E> {
  readonly sequence: number;
  readonly receipt: string;
  readonly request: Q;
  readonly scope?: ScopeBoundary;
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

/** Accepted count and the identity of the last accepted entry. */
export interface JournalPosition {
  readonly position: number;
  readonly receipt: string | null;
}

/** Immutable history prefix. Reads never include entries beyond the captured end. */
export interface AcceptedHistory<Q, V, E, Y> {
  readonly end: JournalPosition;
  at(sequence: number): Operation<Accepted<Q, V, E> | undefined, Y>;
  read(from: number, limit: number): Operation<readonly Accepted<Q, V, E>[], Y>;
}

/** Trusted accepted history and an optional acceleration checkpoint. */
export interface RecoveryPlan<Q, V, E, S, Y> {
  readonly history: AcceptedHistory<Q, V, E, Y>;
  readonly checkpoint?: Checkpoint<S>;
  readonly cancellation?: RootCancellation<Q>;
}

/** Live recovered continuation owned by the executing scope. */
export interface Recovered<R, Q, Y, V, E> extends RestoredGuest<R, Q, Y, V, E> {
  readonly program: string;
  /** Receipt anchoring the accepted prefix already consumed by this Guest. */
  readonly receipt: string | null;
  readonly position: number;
}

/** Scoped recovery hooks; reconstruction never invokes a business handler. */
export interface RecoveryMethods<R, Q, Y, V, E, S> {
  /** Replay accepted Outcomes, or restore through installed checkpoint middleware. */
  recover(plan: RecoveryPlan<Q, V, E, S, Y>): Operation<Recovered<R, Q, Y, V, E>, Y>;
  /**
   * Reconcile a live continuation with accepted history and cancellation control.
   * Its execution driver and owning scope must still be live. Does not acquire,
   * restore, deliver work or select a Guest lifetime policy.
   */
  advance(
    current: Recovered<R, Q, Y, V, E>,
    plan: RecoveryPlan<Q, V, E, S, Y>,
  ): Operation<Recovered<R, Q, Y, V, E>, Y>;
  /** Capture an owned suspended evaluator; undefined means capture is unavailable. */
  checkpoint(
    recovered: Recovered<R, Q, Y, V, E>,
    position: JournalPosition,
  ): Operation<Checkpoint<S> | undefined, Y>;
}

/** Stable delivery identity for an unanswered journal request. */
export interface PendingRequest<Q> {
  readonly id: string;
  readonly sequence: number;
  readonly request: Q;
  readonly scope?: ScopeBoundary;
}

/** An owned call belongs to one exact parent boundary, including across replay. */
export interface ChildLink {
  readonly parentId: string;
  readonly requestId: string;
  readonly childId: string;
  readonly program: string;
  readonly input: unknown;
}

/** Detached execution state; revision guards activation writes. */
export type JournalSnapshot<R, Q, S> = {
  readonly program: string;
  readonly revision: number;
  readonly frontier: JournalPosition;
  /** Normalized root invocation input, pinned before execution; absent for unadmitted journals. */
  readonly admission?: { readonly input: unknown };
  readonly checkpoint?: Checkpoint<S>;
  readonly cancellation?: RootCancellation<Q>;
} & (
  | {
      readonly status: "running";
      readonly pending?: PendingRequest<Q>;
      /** Ordered active owned call. Parent waits until every sibling has settled. */
      readonly children?: readonly ChildLink[];
      /** Intent waiting for an owned child to drain; not yet supplied to the evaluator. */
      readonly cancellationRequested?: RootCancellation<Q>;
    }
  | { readonly status: "completed"; readonly value: R }
  | { readonly status: "cancelled"; readonly reason: string; readonly failure?: string }
);

/** Bound to one execution. Mutations are atomic; revisions reject stale activation writes. */
export interface Journal<R, Q, V, E, S, Y> {
  /** Optional atomic root cancellation; evaluator support is also required. */
  readonly cancellation?: CancellationJournal<Q, Y>;
  /** Read current state without acquiring or advancing computation. */
  read(): Operation<
    JournalSnapshot<R, Q, S> & { readonly history: AcceptedHistory<Q, V, E, Y> },
    Y
  >;
  /**
   * Commit a pending request and optional checkpoint at the expected revision.
   * Throws on stale revision, divergent pending request or invalid checkpoint anchor.
   * Undefined means queued cancellation won at this boundary; reactivate to unwind.
   */
  park(
    revision: number,
    request: Q,
    checkpoint?: Checkpoint<S>,
    scope?: ScopeBoundary,
  ): Operation<PendingRequest<Q> | undefined, Y>;
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
  | { readonly state: "completed"; readonly value: R }
  | { readonly state: "cancelled"; readonly reason: string; readonly failure?: string };

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
   * Commit a grant before delivery, or report the current occupied/invalidated attempt.
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
    | { readonly state: "occupied"; readonly grant: AttemptGrant }
    | { readonly state: "invalidated"; readonly grant: AttemptGrant; readonly reason: string },
    Y
  >;
  /**
   * Accept only a current, eligible grant's Outcome. Invalidated grants throw;
   * eligibility and acceptance must share an atomic boundary. Replaced grants throw even after the
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
  /**
   * Resolve the stored request for this exact resolution grant, including accepted
   * redeliveries. Unknown/revoked grants reject. This read does not reserve authority;
   * answer must recheck it atomically after any external validation.
   */
  request(grant: ResolutionGrant): Operation<Q, Y>;
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

/** Durable eligibility of an exact attempt; acceptance and invalidation are mutually exclusive. */
export type AttemptState<Q, V, E> = { readonly state: "active" } | Invalidation<Q, V, E>;

/** Optional control of executing attempts, bound to the same journal as Attempts. */
export interface AttemptControl<Q, V, E, Y> {
  /** Read eligibility, rejecting stale/replaced grants. Used once after subscribing, not before each write. */
  inspect(grant: AttemptGrant): Operation<AttemptState<Q, V, E>, Y>;
  /**
   * Atomically revoke an exact grant or return the acceptance that won first.
   * Repeated invalidation retains its first reason. Subsequent settle and replacement
   * must reject. No authored failure is recorded and no logical cleanup is implied.
   * Storage must check eligibility within settle's atomic write, not via a prior read.
   */
  invalidate(grant: AttemptGrant, reason: string): Operation<Invalidation<Q, V, E>, Y>;
}

/** Control history anchored before the next accepted outcome; never a fabricated domain failure. */
export interface RootCancellation<Q> {
  readonly position: number;
  readonly requestId: string;
  readonly request: Q;
  readonly scope?: ScopeBoundary;
  readonly reason: string;
  /** Failure from a drained owned child, retained while parent cleanup runs. */
  readonly failure?: string;
  /** Revoked delivery, retained so repeated commands can retry notification. */
  readonly attempt?: AttemptGrant;
}

/** Root cancellation at an observed parked request, bound to this journal. */
export interface CancellationJournal<Q, Y> {
  /**
   * Atomically record intent and revoke the pending attempt/interaction. Stale request
   * IDs reject. Repeating the original ID preserves the first reason, including during
   * cleanup; it never invalidates cleanup grants. An active owned child retains the
   * parent boundary as cancellationRequested until child settlement releases it.
   * Does not advance authored code.
   */
  request(requestId: string, reason: string): Operation<RootCancellation<Q>, Y>;
  /** Commit cancelled completion at the expected revision after cleanup has drained. */
  finish(revision: number, failure?: string): Operation<void, Y>;
}

/** Recovery policy plus its inferred, scoped evaluator API; raw Guests retain checkpoint identity. */
export interface Recovery<R, Q, Y, V, E, S> extends Api<RecoveryMethods<R, Q, Y, V, E, S>, Y> {
  readonly execution: Execution<R, Q, Y, V, E>;
}

/** Trusted journal assembly. Equality defines duplicate domain delivery. */
export interface JournalBindingOptions {
  readonly program: string;
  readonly equals: (left: unknown, right: unknown) => boolean;
}

/** Owned call assembly; program/input are compared on reacquisition. */
export interface OwnedChildOptions<R, V, E> {
  readonly program: string;
  readonly input: unknown;
  /** Pure terminal projection. Must not perform effects; failures leave both journals unchanged. */
  readonly outcome: (value: R) => Outcome<V, E>;
}

/** Nonempty ordered owned call group. One pure projection runs after every child completes. */
export interface OwnedChildrenOptions<C, V, E> {
  readonly children: readonly { readonly program: string; readonly input: unknown }[];
  /** Values follow declaration order, regardless of completion order. Must perform no effects. */
  readonly outcome: (values: readonly C[]) => Outcome<V, E>;
}

/** Typed journal capabilities sharing the adapter's atomic transaction boundary. */
export interface OwnedJournal<R, Q, V, E, S = unknown, Y = never> extends Journal<
  R,
  Q,
  V,
  E,
  S,
  Y
> {
  readonly id: string;
  /**
   * Pin normalized root input atomically before execution. Program must match this
   * journal. Equal resubmissions return the stored value; conflicting input rejects,
   * including after completion. First admission rejects an already advanced journal
   * or an owned child (whose input is pinned by ensureChild). No schema runs here.
   * A successful first admission increments revision without appending history.
   */
  admit(program: string, input: unknown): Operation<unknown, Y>;
  readonly cancellation: CancellationJournal<Q, Y>;
  readonly attempts: Attempts<Q, V, E, Y>;
  readonly attemptControl: AttemptControl<Q, V, E, Y>;
  readonly interactions: Interactions<Q, V, E, Y>;
  /**
   * Atomically acquire a nonempty ordered sibling group at one pending boundary.
   * Reacquisition checks count, order, programs and inputs, retaining the original
   * projection within this open assembly. A fresh assembly supplies fresh bindings.
   * Cancellation fences active descendants together and joins every child's logical
   * cleanup before parent unwind. Completed siblings are retained, never redelivered.
   * Delivery exceptions remain unsettled attempts; they are not durable child failures.
   */
  ensureChildren<C, CQ, CV, CE, CS = unknown>(
    requestId: string,
    options: OwnedChildrenOptions<C, V, E>,
  ): Operation<readonly OwnedChild<C, CQ, CV, CE, CS, Y>[], Y>;
  /**
   * Bind one child to the exact pending call. Reacquisition checks program/input;
   * callers must use the same type contract for that program. Reacquisition returns
   * a fresh handle to the same stored child and retains its original result projection within that open assembly.
   * This is trusted local assembly, not wire validation. Child creation and ownership
   * publish together; child completion atomically settles the parent in the same tree.
   */
  ensureChild<C, CQ, CV, CE, CS = unknown>(
    requestId: string,
    options: OwnedChildOptions<C, V, E>,
  ): Operation<OwnedChild<C, CQ, CV, CE, CS, Y>, Y>;
}

/** The child journal is driven with ordinary recovery/hosting, without a handler attempt for the call. */
export interface OwnedChild<R, Q, V, E, S = unknown, Y = never> {
  readonly link: ChildLink;
  readonly journal: OwnedJournal<R, Q, V, E, S, Y>;
}

/** Current state of one member of a colocated owned execution tree. */
export interface JournalRecord<R = unknown, Q = unknown, S = unknown> {
  snapshot: JournalSnapshot<R, Q, S>;
  queuedStop?: string;
  parent?: ChildLink;
}

/** Retained authority for one request; never grows with unrelated requests. */
export interface RequestRecord {
  grant?: AttemptGrant;
  revoked?: string;
  registration?: InteractionRegistration;
  children?: readonly ChildLink[];
}

/** Transaction-local storage access. Reads are detached; writes publish only on commit. */
export interface JournalRecords<Y> {
  get(id: string): Operation<JournalRecord | undefined, Y>;
  set(id: string, record: JournalRecord): Operation<void, Y>;
  request(id: string, requestId: string): Operation<RequestRecord | undefined, Y>;
  setRequest(id: string, requestId: string, record: RequestRecord): Operation<void, Y>;
  accepted(
    id: string,
    receipt: string,
  ): Operation<Accepted<unknown, unknown, unknown> | undefined, Y>;
  append(id: string, entry: Accepted<unknown, unknown, unknown>): Operation<void, Y>;
}

declare const transactionInstruction: unique symbol;
/** Opaque local registration consumed by the transaction interpreter, never persisted. */
export interface TransactionInstruction {
  readonly [transactionInstruction]: true;
}

/** One transaction's record access and commit obligations. */
export interface JournalTransaction<Y> {
  readonly records: JournalRecords<Y>;
  /**
   * Register when advanced. On confirmed commit, publish synchronously in registration
   * order before releasing ownership or suspending. Rollback discards registrations.
   * Trusted nonthrowing local bookkeeping only: no asynchronous work or remote effects.
   * Retained operations cannot register in another or already-closed transaction.
   */
  onCommit(publish: () => void): Operation<void, TransactionInstruction>;
}

/** Adapter port. One serializable ownership domain, including absent records. */
export interface JournalBackend<Y> {
  /**
   * Invoke work once; only storage operations may suspend inside the transaction.
   * Resolve external dependencies before locking. Publish after commit; roll back
   * uncommitted work on failure/disposal and drain cleanup before releasing locks.
   * After confirmed commit, run registered publications synchronously, exactly once, before another
   * transaction in this assembly can begin or any suspension/cancellation point. Discard registrations on
   * rollback. Publications are trusted local bookkeeping, not asynchronous effects.
   * Adapters must protect commit confirmation and publication from interruption, including
   * joining an in-flight commit during disposal. A lost caller acknowledgement does not
   * undo publication. Unknown database commit outcomes require durable reconciliation.
   * No implicit retries.
   */
  transact<T>(
    work: (transaction: JournalTransaction<Y>) => Operation<T, Y | TransactionInstruction>,
  ): Operation<T, Y>;
  /** Immutable accepted rows in [from, end), limited to at most limit entries. No write lock. */
  history(
    id: string,
    from: number,
    end: number,
    limit: number,
  ): Operation<readonly Accepted<unknown, unknown, unknown>[], Y>;
}
