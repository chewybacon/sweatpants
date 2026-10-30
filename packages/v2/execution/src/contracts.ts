import type { Api, Operation, Outcome, Work } from "@standard-durability/core";

/** A returned boundary; suspension does not imply durable acceptance. */
export type Turn<Result, Request> =
  | { readonly kind: "suspended"; readonly request: Request; readonly scope?: ScopeBoundary }
  | { readonly kind: "completed"; readonly value: Result }
  | { readonly kind: "cancelled"; readonly reason: string; readonly failure?: string };

/** A live continuation. Native operations advance it; domain requests are returned as data. */
export interface Guest<Result, Request, Y, Value = unknown, Error = unknown> {
  start(): Operation<Turn<Result, Request>, Y>;
  resume(outcome: Outcome<Value, Error>): Operation<Turn<Result, Request>, Y>;
  /**
   * Optional logical root cancellation. Advances authored cleanup to its next boundary.
   * Repeated calls preserve the current cleanup suspension/terminal boundary. A caught
   * or overridden language return cannot turn cancellation into successful completion.
   *
   * @remarks Cleanup support is evaluator-specific. The scoped driver drains registered
   * {@link LogicalScope.ensure} callbacks and preserves cleanup already in progress.
   * Cancellation discards unprotected body iterators without running their arbitrary
   * JavaScript finally blocks; register logical obligations with ensure.
   */
  cancel?(reason: string): Operation<Turn<Result, Request>, Y>;
  /**
   * Idempotently dispose this incarnation without advancing or unwinding authored code.
   * Does not run logical cleanup or finally blocks in discarded iterators. The acquiring
   * host separately owns native physical-resource cleanup; durable recovery reconstructs
   * logical continuations rather than treating host disposal as workflow cancellation.
   */
  close(): Operation<void, Y>;
}

/**
 * Data supplied to scoped program acquisition. Placement may change across incarnations;
 * the pinned program and admitted input may not. This is not a grant or an execution ID.
 */
export interface ProgramInvocation<Input = unknown> {
  /**
   * Immutable replay-contract reference persisted by the owning journal. Assembly resolves
   * and verifies it before fresh acquisition or checkpoint restoration. A friendly tool
   * name alone is insufficient; the reference must account for executable and contract
   * revisions. Its representation and artifact verification belong to assembly/tooling.
   */
  readonly program: string;
  /** Already-normalized input from admission; acquisition must not rerun author transforms. */
  readonly input: Input;
}

/** Acquire a fresh guest and its physical resources without advancing the authored body. */
export type GuestWork<Result, Request, Y, Value = unknown, Error = unknown> = Work<
  Guest<Result, Request, Y, Value, Error>,
  Y
>;

/**
 * Scoped API over existing Guest methods. Middleware and driver selection resolve
 * in the executing scope; the facade does not capture a particular continuation.
 * Cancellation dispatch is always available, but an unsupported driver rejects it.
 */
export interface Execution<R, Q, Y, V = unknown, E = unknown> extends Omit<
  Api<Required<Guest<R, Q, Y, V, E>>, Y>,
  "install"
> {
  /**
   * Install this Guest as the current scope's driver and own its physical disposal.
   * One driver per scope; children may override it. Cleanup closes this exact Guest,
   * even if middleware redirects calls. It does not dispatch through the facade.
   */
  install(guest: Guest<R, Q, Y, V, E>): Operation<void, Y>;
  /** Whether this exact Guest is the visible installed driver and has not been closed.
   * Scope exit invalidates the binding before physical disposal begins. This is a
   * local lifetime check, not an authority lease or a guarantee against concurrent use.
   */
  isInstalled(guest: Guest<R, Q, Y, V, E>): Operation<boolean, Y>;
}

/** Replay-stable identity of the logical frame owning a suspension. */
export interface ScopeBoundary {
  readonly scopeId: string;
  readonly frameId: string;
  /** Cleanup remains eligible when root cancellation changes the exit disposition. */
  readonly phase: "body" | "cleanup";
  /** Outermost active critical region; cancellation preserves its request authority. */
  readonly critical?: string;
}

declare const logicalInstruction: unique symbol;
/** Opaque evaluator instruction; consumed before domain requests reach hosting. */
export interface ScopeInstruction {
  readonly [logicalInstruction]: true;
}

/**
 * Registered logical cleanup drains in reverse registration order on logical scope exit.
 * Host disposal discards live callbacks; durable replay reconstructs registrations.
 *
 * @remarks Register cancellation-sensitive cleanup with ensure. The scoped evaluator
 * does not run arbitrary finally blocks in body iterators discarded by cancellation.
 * Normal JavaScript return/exception behavior is unchanged while an iterator advances.
 * Standard iterators expose no body-versus-finally phase; stronger finally guarantees
 * require instrumentation, compilation or explicit evaluator support.
 */
export interface LogicalScope {
  /**
   * Register logical cleanup in this scope, before its body exits. Cleanup may suspend
   * for domain replies and is joined before the scope settles. Cancellation arriving
   * during registered cleanup preserves its current continuation and reply authority;
   * remaining registered callbacks are attempted even if a callback fails.
   *
   * This does not install native physical cleanup and does not run on host disposal.
   * Registration takes effect when this operation is advanced. Durable replay must
   * reconstruct the same registration order from the pinned program and accepted data.
   *
   * @example
   * ```ts
   * yield* scope.ensure(function* () {
   *   yield* release(hold);
   *   yield* audit();
   * });
   * ```
   */
  ensure<Q>(cleanup: Work<void, Q>): Operation<void, Q | ScopeInstruction>;
  /**
   * Defer logical cancellation until this region exits. Intent is recorded immediately,
   * but outstanding replies and owned work remain eligible; nested regions retain the
   * outer mask. Pending cancellation unwinds before the caller's body resumes.
   *
   * This is not a new logical scope: ensure registers on the existing owner and runs
   * at that scope's exit, not at the end of critical. Exceptions still propagate when
   * cancellation is absent. Cleanup is already protected and needs no critical wrapper.
   *
   * Native host disposal is still allowed; replay reconstructs the mask. A parked or
   * indeterminate region can delay cancellation indefinitely until reply/reconciliation.
   * This provides neither transactionality nor exactly-once external effects.
   *
   * @example
   * ```ts
   * const hold = yield* scope.critical(function* () {
   *   const acquired = yield* reserve();
   *   yield* scope.ensure(function* () { yield* release(acquired.id); });
   *   return acquired;
   * });
   * ```
   */
  critical<R, Q>(work: Work<R, Q>): Operation<R, Q | ScopeInstruction>;
  /** Run an owned lexical scope, joining its cleanup before returning its inferred result. */
  scoped<R, Q>(work: (scope: LogicalScope) => Operation<R, Q>): Operation<R, Q | ScopeInstruction>;
}

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

/** Verified artifact selection with input already bound; resolution itself creates no Guest. */
export interface ResolvedProgram<R, Q, Y, V = unknown, E = unknown, S = unknown> {
  /** Actual immutable reference derived/asserted by the trusted artifact resolver. */
  readonly program: string;
  readonly acquire: GuestWork<R, Q, Y, V, E>;
  readonly checkpoints?: CheckpointAdapter<R, Q, Y, V, E, S>;
}

/** Bound invocation usable by ordinary recovery, with explicitly optional checkpoint support. */
export interface ProgramExecution<R, Q, Y, V = unknown, E = unknown, S = unknown> {
  readonly acquire: GuestWork<R, Q, Y, V, E>;
  readonly checkpoints: CheckpointAdapter<R, Q, Y, V, E, S> | undefined;
}

/** Artifact lookup is caller-owned and may be an ordinary scoped API operation. */
export interface ProgramExecutionOptions<I, P, Y> {
  /** Input must remain immutable after binding; admission owns normalization. */
  readonly invocation: ProgramInvocation<I>;
  /** Resolve without acquiring a Guest; return the artifact's actual reference. */
  resolve(invocation: ProgramInvocation<I>): Operation<P, Y>;
  /** Omit for replay-only execution. A supported restore requires this exact adapter format. */
  readonly checkpointFormat?: string;
}

/** Preserve the resolved Guest/snapshot types and include the resolver's native instructions. */
export type ProgramExecutionFrom<P, Y> =
  P extends ResolvedProgram<infer R, infer Q, infer G, infer V, infer E, infer S>
    ? ProgramExecution<R, Q, Y | G, V, E, S>
    : never;
