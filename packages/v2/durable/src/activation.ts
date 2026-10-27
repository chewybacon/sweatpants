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
  return composition.scoped(function* () {
    const snapshot = yield* journal.read();
    if (snapshot.status === "cancelled") {
      return {
        state: "cancelled",
        reason: snapshot.reason,
        failure: snapshot.failure,
      };
    }
    if (snapshot.status === "completed") {
      return { state: "completed", value: snapshot.value };
    }
    const recovered = yield* recovery.recover(snapshot);
    if (recovered.program !== snapshot.program || recovered.position !== snapshot.history.length) {
      throw new Error("Recovery differs from journal position");
    }
    if (recovered.turn.kind === "cancelled") {
      if (!snapshot.cancellation || !journal.cancellation) {
        throw new Error("Evaluator cancelled without committed cancellation intent");
      }
      yield* journal.cancellation.finish(snapshot.revision, recovered.turn.failure);
      return {
        state: "cancelled",
        reason: snapshot.cancellation.reason,
        failure: recovered.turn.failure,
      };
    }
    if (recovered.turn.kind === "completed") {
      yield* journal.complete(snapshot.revision, recovered.turn.value);
      return { state: "completed", value: recovered.turn.value };
    }
    const checkpoint = snapshot.cancellation
      ? undefined
      : yield* recovery.checkpoint(recovered, snapshot.history);
    const pending = yield* journal.park(snapshot.revision, recovered.turn.request, checkpoint);
    return { state: "parked", pending };
  });
}
