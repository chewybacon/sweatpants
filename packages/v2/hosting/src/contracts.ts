import type { Api, Context, Handler, Operation, Outcome } from "@standard-durability/core";
import type {
  RootCancellation,
  AttemptControl,
  AlarmIntent,
  AttemptGrant,
  RetrySafety,
  Attempts,
  Journal,
  RecoveryMethods,
  PendingRequest,
  InteractionRegistration,
  Interactions,
  ResolutionGrant,
  Acceptance,
  Invalidation,
} from "@sweatpan.ts/durable";

/** Completion, an occupied/invalidated attempt, or a registered participant wait/invalidation. */
export type HostedResult<R, Q = unknown> =
  | { readonly state: "completed"; readonly value: R }
  | { readonly state: "cancelled"; readonly reason: string; readonly failure?: string }
  | { readonly state: "occupied"; readonly grant: AttemptGrant }
  | { readonly state: "invalidated"; readonly grant: AttemptGrant; readonly reason: string }
  | (InteractionRegistration & { readonly pending: PendingRequest<Q> });

/** Scoped middleware hooks for delivery, retry policy and the hosting loop. */
export interface HostingMethods<R, Q, V, E, Y> {
  /**
   * Run until completion, an occupied attempt, or a participant wait/invalidation.
   * Concurrent activation may throw a
   * journal revision conflict before an attempt can be observed. Callers may retry
   * activation; never infer permission to redeliver an effect from that failure.
   *
   * Replacement compares the supplied current grant and requires recorded and
   * current policy to be repeatable. Elapsed time does not establish ownership loss.
   * Native cancellation shuts down this host; it does not cancel the durable
   * workflow or record a failure Outcome. An unsettled grant remains occupied.
   */
  run(replace?: AttemptGrant): Operation<HostedResult<R, Q>, Y>;
  /** Request root cancellation at a parked boundary; run() subsequently drives cleanup. */
  cancel(requestId: string, reason: string): Operation<RootCancellation<Q>, Y>;
  /** Choose local participant registration or attempted handler execution; defaults to execute. */
  deliveryMode(request: Q): Operation<"execute" | "wait", Y>;
  /** Record a participant answer without advancing computation; call run to recover afterward. */
  answer(grant: ResolutionGrant, outcome: Outcome<V, E>): Operation<Acceptance<Q, V, E>, Y>;
  /** Fence a pending reply, or observe the answer that already won. Does not unwind the workflow. */
  invalidate(grant: ResolutionGrant, reason: string): Operation<Invalidation<Q, V, E>, Y>;
  /** Revoke an executing attempt, or observe its accepted result. Does not unwind the workflow. */
  invalidateAttempt(grant: AttemptGrant, reason: string): Operation<Invalidation<Q, V, E>, Y>;
  /** Return domain Outcome data; thrown transport failures leave the attempt unsettled. */
  handle(request: Q): Operation<Outcome<V, E>, Y>;
  /** Delivery policy; defaults to unsafe and is recorded in the granted attempt. */
  retrySafety(request: Q): Operation<RetrySafety, Y>;
}

/** Public hosting API and its scoped delivery identity. */
export interface Hosting<R, Q, V, E, Y> extends Api<HostingMethods<R, Q, V, E, Y>, Y> {
  /** Current handler grant; inherited by its cleanup, absent outside the delivery scope. */
  readonly delivery: Context<AttemptGrant, Y>;
}

/** Bind recovery and attempt storage for the same execution to its domain handler. */
export interface HostingOptions<R, Q, V, E, S, Y> {
  readonly name: string;
  readonly recovery: RecoveryMethods<R, Q, Y, V, E, S>;
  readonly journal: Journal<R, Q, V, E, S, Y>;
  readonly attempts: Attempts<Q, V, E, Y>;
  /** Optional durable invalidation; must control the same attempts. */
  readonly attemptControl?: AttemptControl<Q, V, E, Y>;
  /** Required when deliveryMode selects wait; must share this journal's execution. */
  readonly interactions?: Interactions<Q, V, E, Y>;
  readonly handle: Handler<Q, Y, Outcome<V, E>>;
}

/**
 * Proposed platform alarm adapter, bound to one execution. No implementation yet.
 * Hosting reconciles this delivery mechanism against durable AlarmIntent records;
 * the scheduler does not decide whether a scope has expired or may be unwound.
 * Methods can be composed with existing OperationMiddleware and scoped APIs.
 */
export interface AlarmScheduler<Y> {
  /**
   * Install a wakeup from committed intent. Repeating the same ID/time is idempotent;
   * reusing an ID with a different time must reject. Scheduling an overdue intent
   * requests prompt delivery. Installation must survive disposal of this host.
   * Duplicate or delayed deliveries are allowed; no callback or live scope is retained.
   */
  schedule(intent: AlarmIntent): Operation<void, Y>;
  /**
   * Idempotently remove this ID's platform wakeup. First retire its durable intent.
   * Delivery may already be in flight, and a stale installation may race removal;
   * the receiver must consult durable state rather than trusting physical removal.
   */
  cancel(id: string): Operation<void, Y>;
}

/**
 * Proposed ingress for platform wakeups, bound to the same execution. No implementation yet.
 * Remote adapters authenticate/route delivery; an alarm ID is not cancellation authority.
 */
export interface AlarmReceiver<Y> {
  /**
   * Re-read durable intent, scope state and authoritative time before acting.
   * Ignore retired/duplicate deliveries. Acknowledge only after recording the
   * applicable durable transition (or ensuring another wakeup for an early delivery).
   * Expiry requests scope cancellation; it does not directly unwind a live Guest.
   */
  deliver(id: string): Operation<void, Y>;
}

/** Optional execution-bound notifications. Loss/delay never grants permission to commit. */
export interface AttemptNotifications<Y> {
  /**
   * Subscribe before checking durable eligibility. The returned signal aborts only
   * for committed invalidation of this exact grant. Register unsubscribe as scoped
   * physical cleanup. Remote adapters own routing and authentication.
   */
  subscribe(grant: AttemptGrant): Operation<AbortSignal, Y>;
  /** Best-effort wakeup after invalidation commits; duplicates are harmless. */
  publish(grant: AttemptGrant): Operation<void, Y>;
}
