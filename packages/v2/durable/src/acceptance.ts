import type { Outcome } from "@standard-durability/core";
import type { AcceptanceTransition, Accepted, AttemptGrant, JournalSnapshot } from "./contracts.ts";

/**
 * Prepare trusted acceptance without publishing. Duplicate delivery preserves revision
 * and receipt; conflicting delivery or an owned-child boundary rejects. The adapter
 * must read, decide and publish atomically, and detach/encode data before publication.
 */
export function acceptJournalOutcome<R, Q, V, E, S>(
  snapshot: JournalSnapshot<R, Q, V, E, S>,
  requestId: string,
  outcome: Outcome<V, E>,
  equals: (left: unknown, right: unknown) => boolean,
): AcceptanceTransition<R, Q, V, E, S> {
  const prior = snapshot.history.find((entry) => entry.receipt === requestId);
  if (prior) {
    if (!equals(prior.outcome, outcome)) {
      throw new Error("Conflicting accepted outcome");
    }
    return { snapshot, acceptance: { entry: prior, duplicate: true } };
  }
  if (snapshot.status !== "running" || snapshot.pending?.id !== requestId) {
    throw new Error("Stale or unknown pending request");
  }
  if (snapshot.child) {
    throw new Error("Owned call can only be accepted by child settlement");
  }
  const entry: Accepted<Q, V, E> = {
    sequence: snapshot.pending.sequence,
    receipt: requestId,
    request: snapshot.pending.request,
    scope: snapshot.pending.scope,
    outcome,
  };
  const { pending: _pending, ...rest } = snapshot;
  return {
    snapshot: {
      ...rest,
      revision: snapshot.revision + 1,
      history: [...snapshot.history, entry],
    },
    acceptance: { entry, duplicate: false },
  };
}

/**
 * Prepare acceptance only for the exact current, non-revoked attempt. Authority is
 * checked before duplicate acknowledgement, so a replaced or revoked grant cannot
 * claim the winner's receipt. Read authority and publish this decision in one transaction;
 * a preceding inspect call is neither necessary nor sufficient to authorize settlement.
 */
export function settleJournalAttempt<R, Q, V, E, S>(
  snapshot: JournalSnapshot<R, Q, V, E, S>,
  authority: { readonly current?: AttemptGrant; readonly revoked?: string },
  grant: AttemptGrant,
  outcome: Outcome<V, E>,
  equals: (left: unknown, right: unknown) => boolean,
): AcceptanceTransition<R, Q, V, E, S> {
  const current = authority.current;
  if (
    !current ||
    current.requestId !== grant.requestId ||
    current.attemptId !== grant.attemptId ||
    current.retrySafety !== grant.retrySafety
  ) {
    throw new Error("Stale attempt grant");
  }
  if (authority.revoked !== undefined) {
    throw new Error("Attempt authority revoked");
  }
  return acceptJournalOutcome(snapshot, grant.requestId, outcome, equals);
}
