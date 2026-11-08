import type { Composition, Operation } from "@standard-durability/core";
import type { Activation, Journal, RecoveryMethods } from "./contracts.ts";

/**
 * Recover from accepted Outcomes, commit a pending request or completion, and join
 * physical Guest disposal before returning. Replays committed cancellation control
 * alongside accepted outcomes; does not execute handlers or initiate cancellation.
 * Persisted terminal state does not acquire an evaluator.
 *
 * @throws If replay diverges, checkpoint recovery fails, or a concurrent journal
 * mutation makes the activation revision stale. No implicit retry is performed.
 */
export function activateJournal<R, Q, Y, V, E, S>(
  composition: Composition<Y>,
  recovery: RecoveryMethods<R, Q, Y, V, E, S>,
  journal: Journal<R, Q, V, E, S, Y>,
): Operation<Activation<R, Q>, Y> {
  return (function* () {
    while (true) {
      const result = yield* composition.scoped(() => advanceJournal(recovery, journal));
      if (result) {
        return result;
      }
    }
  })();
}

/**
 * Attempt to publish the next durable boundary in the caller's owning scope. Recovery selects
 * how to obtain a continuation; this operation owns no cache or lifetime policy.
 * The caller must join the scope that owns recovered Guests. Use activateJournal
 * when that scope should end before returning the boundary. Undefined means queued
 * cancellation won at park; advance again to reconcile it.
 */
export function advanceJournal<R, Q, Y, V, E, S>(
  recovery: RecoveryMethods<R, Q, Y, V, E, S>,
  journal: Journal<R, Q, V, E, S, Y>,
): Operation<Activation<R, Q> | undefined, Y> {
  return (function* () {
    const snapshot = yield* journal.read();
    if (snapshot.status === "cancelled") {
      return {
        state: "cancelled" as const,
        reason: snapshot.reason,
        failure: snapshot.failure,
      };
    }
    if (snapshot.status === "completed") {
      return { state: "completed" as const, value: snapshot.value };
    }
    if (snapshot.children) {
      if (!snapshot.pending) {
        throw new Error("Owned child requires its parent call boundary");
      }
      return { state: "parked" as const, pending: snapshot.pending };
    }
    const recovered = yield* recovery.recover(snapshot);
    if (
      recovered.program !== snapshot.program ||
      recovered.position !== snapshot.frontier.position
    ) {
      throw new Error("Recovery differs from journal position");
    }
    if (recovered.turn.kind === "cancelled") {
      if (!snapshot.cancellation || !journal.cancellation) {
        throw new Error("Evaluator cancelled without committed cancellation intent");
      }
      const failure =
        [snapshot.cancellation.failure, recovered.turn.failure]
          .filter((value) => value !== undefined)
          .join("\n") || undefined;
      yield* journal.cancellation.finish(snapshot.revision, failure);
      return {
        state: "cancelled" as const,
        reason: snapshot.cancellation.reason,
        failure,
      };
    }
    if (recovered.turn.kind === "completed") {
      yield* journal.complete(snapshot.revision, recovered.turn.value);
      return { state: "completed" as const, value: recovered.turn.value };
    }
    const checkpoint = snapshot.cancellation
      ? undefined
      : yield* recovery.checkpoint(recovered, snapshot.frontier);
    const pending = yield* journal.park(
      snapshot.revision,
      recovered.turn.request,
      checkpoint,
      recovered.turn.scope,
    );
    return pending ? { state: "parked" as const, pending } : undefined;
  })();
}
