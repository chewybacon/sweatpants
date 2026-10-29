import type { CapabilityRequest, EffectDefinition } from "@sweatpan.ts/core";
import type { Api, Context, Handler, Operation, Outcome } from "@standard-durability/core";
import type {
  Activation,
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
  | { readonly state: "child"; readonly childId: string }
  | { readonly state: "completed"; readonly value: R }
  | { readonly state: "cancelled"; readonly reason: string; readonly failure?: string }
  | { readonly state: "occupied"; readonly grant: AttemptGrant }
  | { readonly state: "invalidated"; readonly grant: AttemptGrant; readonly reason: string }
  | (InteractionRegistration & { readonly pending: PendingRequest<Q> });

/** Drive an owned child through its ordinary host; storage atomically settles its parent call. */
export interface ChildHosting<Y> {
  readonly id: string;
  /** True after terminal settlement; false when child is parked or occupied. */
  run(): Operation<boolean, Y>;
}

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
  /** Advance to a durable boundary. Defaults to recovery in a disposable scope. */
  activate(): Operation<Activation<R, Q>, Y>;
  /** Optional owned-call routing, before attempt or participant acquisition. Defaults to no child. */
  child(pending: PendingRequest<Q>): Operation<ChildHosting<Y> | undefined, Y>;
  /** Request root cancellation at a parked boundary; run() subsequently drives cleanup. */
  cancel(requestId: string, reason: string): Operation<RootCancellation<Q>, Y>;
  /** Choose local participant registration or attempted handler execution; defaults to execute. */
  deliveryMode(request: Q): Operation<"execute" | "wait", Y>;
  /**
   * Record a participant answer without advancing computation. Effect-answer middleware
   * accepts a raw authored Outcome and validates it against the grant's stored request;
   * the generic driver accepts prepared transport Outcomes. Call run to recover afterward.
   */
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

/** Raw participant-answer view, usable in the scope where effect-answer middleware is installed. */
export interface EffectAnswers<E, Y> {
  /**
   * Submit an authored Outcome, including structured failures. Success is normalized
   * by the selected effect schema; the journal retains its transport error type E.
   * Use only within the installation scope (or its descendants).
   */
  answer(
    grant: ResolutionGrant,
    outcome: Outcome<unknown, unknown>,
  ): Operation<Acceptance<CapabilityRequest, unknown, E>, Y>;
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

/** Selected callable effects and their host admission/delivery boundary. */
export type EffectGrant<D extends Record<string, EffectDefinition>, Y> = {
  /** Selected aliases retain each definition's exact callable signature. */
  readonly capabilities: { readonly [K in keyof D]: D[K]["call"] };
  /** Install as outer child middleware, before routing; it admits without executing or parsing. */
  readonly admission: {
    /** Check membership before routing or delivery authority; performs no schema parsing. */
    child<P extends { readonly request: CapabilityRequest }, R>(
      args: [P],
      next: (pending: P) => Operation<R, Y>,
    ): Operation<R, Y>;
  };
  /**
   * Validate/transform an already received authored Outcome using the granted request's
   * response schema, without executing a handler or parsing request context again.
   * Failures bypass the success schema. Dynamic ingress accepts unknown payloads;
   * the selected definition restores the response contract at runtime.
   */
  respond(
    request: CapabilityRequest,
    outcome: Outcome<unknown, unknown>,
  ): Operation<Outcome<unknown, unknown>, Y>;
  /** Deliver a granted request; authored Outcome is carried as a successful reply value. */
  handle(request: CapabilityRequest): Operation<Outcome<unknown, string>, Y>;
};

/** Host-owned assembly; definitions themselves retain no installed runtime state. */
export interface EffectCapabilities<Y> {
  /** Install a compatible default in the current scope. */
  install<C, R, I, O, E>(
    definition: EffectDefinition<C, R, I, O, E> & {
      readonly implementation: (context: C) => Operation<Outcome<O, E>, Y>;
    },
  ): Operation<void, Y>;
  /** Install a scoped replacement preserving the definition's success/error contract. */
  install<C, R, I, O, E>(
    definition: EffectDefinition<C, R, I, O, E>,
    handler: (context: NoInfer<C>) => Operation<Outcome<NoInfer<O>, NoInfer<E>>, Y>,
  ): Operation<void, Y>;
  /** Access scoped handler middleware over normalized context and raw success values. */
  api<C, R, I, O, E>(
    definition: EffectDefinition<C, R, I, O, E>,
  ): Api<
    {
      /** Return authored success/failure data; exceptions remain delivery errors. */
      handle(context: C): Operation<Outcome<O, E>, Y>;
    },
    Y
  >;
  /** Select callable definitions. Installation alone does not grant access. */
  grant<const D extends Record<string, EffectDefinition>>(selected: D): EffectGrant<D, Y>;
  /** Enable local recording for one Guest; reacquisition must reconstruct a fresh grant. */
  grant<const D extends Record<string, EffectDefinition>>(
    selected: D,
    local: { record: true },
  ): EffectGrant<D, Y> & {
    /** Install this Guest's record binding in its acquisition scope. Scope exit clears it. */
    install(): Operation<void, Y>;
    /**
     * Supply an inline operation under the ordinary effect attempt. The non-empty key
     * identifies the operation semantically; sequence distinguishes repeated calls.
     * Replay compares both. Keys are not global deduplication tokens. Return Outcome
     * data; exceptions are delivery errors. Native asynchronous work and physical
     * cleanup are supported. Nested durable exchanges are not. Replay skips accepted
     * work. This evaluator requires retention; Lua inline execution is not implemented.
     */
    record<Result extends Outcome<unknown, unknown>>(
      options: { readonly key: string },
      work: () => Operation<Result, Y>,
    ): Operation<Result, CapabilityRequest>;
  };
}
