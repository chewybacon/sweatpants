import type { CancellationTransition } from "./types.ts";
import type { Outcome } from "@standard-durability/core";
import type { AttemptGrant, ChildLink, JournalSnapshot, RootCancellation } from "./contracts.ts";

/**
 * Prepare cancellation at an exact boundary. Cleanup and critical regions keep authority;
 * a body-owned child delays parent unwinding. No evaluator or storage is invoked.
 */
export function requestJournalCancellation<R, Q, S>(
  snapshot: JournalSnapshot<R, Q, S>,
  requestId: string,
  reason: string,
  attempt?: AttemptGrant,
): CancellationTransition<R, Q, S> {
  const prior =
    snapshot.cancellation ??
    (snapshot.status === "running" ? snapshot.cancellationRequested : undefined);
  if (prior) {
    if (prior.requestId !== requestId) {
      throw new Error("Root cancellation already requested at another boundary");
    }
    return { snapshot, cancellation: prior, revoke: false };
  }
  if (snapshot.status !== "running" || snapshot.pending?.id !== requestId) {
    throw new Error("Stale or unknown cancellation boundary");
  }
  const protectedBoundary =
    snapshot.pending.scope?.phase === "cleanup" || snapshot.pending.scope?.critical !== undefined;
  const cancellation: RootCancellation<Q> = {
    position: snapshot.frontier.position,
    requestId,
    request: snapshot.pending.request,
    scope: snapshot.pending.scope,
    reason,
    attempt: protectedBoundary ? undefined : attempt,
  };
  const { checkpoint: _checkpoint, ...rest } = snapshot;
  const revision = snapshot.revision + 1;
  if (protectedBoundary) {
    return { snapshot: { ...rest, cancellation, revision }, cancellation, revoke: false };
  }
  if (snapshot.children) {
    return {
      snapshot: { ...rest, cancellationRequested: cancellation, revision },
      cancellation,
      revoke: true,
      childrenToCancel: snapshot.children,
    };
  }
  const { pending: _pending, ...ready } = rest;
  return { snapshot: { ...ready, cancellation, revision }, cancellation, revoke: true };
}

/**
 * Prepare the parent half of owned-child settlement. The adapter must commit this
 * and the child's terminal record together. A completed child requires its typed
 * result already projected to the parent's Outcome; projection executes outside this transition.
 */
export function settleOwnedChild<R, Q, V, E, S>(
  parent: JournalSnapshot<R, Q, S>,
  link: ChildLink,
  result:
    | { readonly status: "completed" }
    | { readonly status: "cancelled"; readonly reason: string; readonly failure?: string },
  outcome?: Outcome<V, E>,
): JournalSnapshot<R, Q, S> {
  if (
    parent.status !== "running" ||
    !parent.children?.some((child) => child.childId === link.childId) ||
    parent.pending?.id !== link.requestId
  ) {
    throw new Error("Stale child settlement");
  }
  const { children: _children, pending, cancellationRequested, ...rest } = parent;
  const revision = parent.revision + 1;
  if (cancellationRequested || result.status === "cancelled") {
    if (
      (pending.scope?.phase === "cleanup" || pending.scope?.critical !== undefined) &&
      result.status === "cancelled"
    ) {
      throw new Error(
        "An independently cancelled protected child requires explicit outcome reconciliation",
      );
    }
    const cancellation = cancellationRequested ?? {
      position: parent.frontier.position,
      requestId: link.requestId,
      request: pending.request,
      scope: pending.scope,
      reason: result.status === "cancelled" ? result.reason : "Child cancelled",
    };
    return {
      ...rest,
      revision,
      checkpoint: undefined,
      cancellation: {
        ...cancellation,
        failure: result.status === "cancelled" ? result.failure : undefined,
      },
    };
  }
  if (!outcome) {
    throw new Error("Completed child requires a projected outcome");
  }
  return {
    ...rest,
    revision,
    frontier: { position: pending.sequence + 1, receipt: link.requestId },
  };
}
