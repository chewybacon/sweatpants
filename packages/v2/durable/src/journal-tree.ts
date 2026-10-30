import { requestJournalCancellation, settleOwnedChild } from "./transitions.ts";
import type { Outcome, Operation } from "@standard-durability/core";
import type {
  ChildLink,
  JournalSnapshot,
  PendingRequest,
  OwnedChildrenOptions,
  JournalBindingOptions,
  JournalRecord,
  JournalRecords,
} from "./contracts.ts";
import type { ChildBindings } from "./types.ts";

/** Initial empty authority record; adapters store this with the pinned program. */
export function createJournalRecord(program: string, parent?: ChildLink): JournalRecord {
  return {
    snapshot: { program, revision: 0, frontier: { position: 0, receipt: null }, status: "running" },
    parent,
  };
}

function* record<Y>(records: JournalRecords<Y>, id: string): Operation<JournalRecord, Y> {
  const found = yield* records.get(id);
  if (!found) {
    throw new Error("Unknown execution identity");
  }
  return found;
}

/** Fence every eligible descendant in the same transaction before publishing cancellation. */
function* cancel<Y>(records: JournalRecords<Y>, id: string, requestId: string, reason: string) {
  const pending: { id: string; boundary?: string }[] = [{ id, boundary: requestId }];
  let root: ReturnType<typeof requestJournalCancellation> | undefined;
  while (pending.length) {
    const item = pending.pop()!;
    const current = yield* record(records, item.id);
    if (item.boundary === undefined) {
      const snapshot = current.snapshot;
      if (
        snapshot.status !== "running" ||
        snapshot.cancellation ||
        snapshot.cancellationRequested
      ) {
        continue;
      }
      if (!snapshot.pending) {
        current.queuedStop ??= reason;
        yield* records.set(item.id, current);
        continue;
      }
      item.boundary = snapshot.pending.id;
    }
    const request =
      current.snapshot.status === "running" && current.snapshot.children
        ? undefined
        : yield* records.request(item.id, item.boundary);
    const decision = requestJournalCancellation(
      current.snapshot,
      item.boundary,
      reason,
      request?.grant,
    );
    root ??= decision;
    current.snapshot = decision.snapshot;
    yield* records.set(item.id, current);
    if (
      decision.revoke &&
      request &&
      (decision.cancellation.attempt || request.registration?.state === "waiting")
    ) {
      if (decision.cancellation.attempt && request.revoked === undefined) {
        request.revoked = reason;
      }
      if (request.registration?.state === "waiting") {
        request.registration = { state: "invalidated", grant: request.registration.grant, reason };
      }
      yield* records.setRequest(item.id, item.boundary, request);
    }
    for (const child of [...(decision.childrenToCancel ?? [])].reverse()) {
      pending.push({ id: child.childId });
    }
  }
  if (!root) {
    throw new Error("Missing cancellation boundary");
  }
  return root.cancellation;
}

/** Transaction-local ownership decisions; bindings are supplied by the open assembly. */
export function createJournalTree<Y>(
  options: JournalBindingOptions,
  records: JournalRecords<Y>,
  bindings: ChildBindings,
) {
  function* settle(records: JournalRecords<Y>, next: JournalRecord) {
    const link = next.parent;
    if (!link || next.snapshot.status === "running") {
      return;
    }
    let parent = yield* record(records, link.parentId);
    if (
      parent.snapshot.status !== "running" ||
      !parent.snapshot.children?.some((child) => child.childId === link.childId) ||
      parent.snapshot.pending?.id !== link.requestId
    ) {
      throw new Error("Stale child settlement");
    }
    const request = yield* records.request(link.parentId, link.requestId);
    if (!request) {
      throw new Error("Missing owned request");
    }
    if (
      request.join === "race" &&
      !request.winner &&
      next.snapshot.status === "completed" &&
      !parent.snapshot.cancellationRequested
    ) {
      // The winner and all eligible loser fences publish with this terminal commit.
      request.winner = link.childId;
      yield* records.setRequest(link.parentId, link.requestId, request);
      for (const sibling of parent.snapshot.children) {
        if (sibling.childId === link.childId) {
          continue;
        }
        const loser = yield* record(records, sibling.childId);
        const state = loser.snapshot;
        if (state.status !== "running" || state.cancellation || state.cancellationRequested) {
          continue;
        }
        if (state.pending) {
          yield* cancel(records, sibling.childId, state.pending.id, "Race lost");
        } else {
          loser.queuedStop ??= "Race lost";
          yield* records.set(sibling.childId, loser);
        }
      }
    }
    if (
      next.snapshot.status === "cancelled" &&
      !parent.snapshot.cancellationRequested &&
      !request.winner
    ) {
      const scope = parent.snapshot.pending.scope;
      if (scope?.phase === "cleanup" || scope?.critical !== undefined) {
        throw new Error(
          "An independently cancelled protected child requires explicit outcome reconciliation",
        );
      }
      yield* cancel(records, link.parentId, link.requestId, next.snapshot.reason);
      parent = yield* record(records, link.parentId);
    }
    if (parent.snapshot.status !== "running" || !parent.snapshot.children) {
      throw new Error("Missing owned group");
    }
    const siblings: JournalRecord[] = [];
    for (const child of parent.snapshot.children) {
      siblings.push(yield* record(records, child.childId));
    }
    if (siblings.some((child) => child.snapshot.status === "running")) {
      return;
    }
    const cancelled = siblings
      .map((child) => child.snapshot)
      .filter((child) => child.status === "cancelled");
    const failure =
      cancelled
        .map((child) => child.failure)
        .filter((value) => value !== undefined)
        .join("\n") || undefined;
    const result =
      request.winner && !parent.snapshot.cancellationRequested
        ? failure
          ? { status: "cancelled" as const, reason: "Race loser cleanup failed", failure }
          : { status: "completed" as const }
        : cancelled.length
          ? { status: "cancelled" as const, reason: cancelled[0]!.reason, failure }
          : { status: "completed" as const };
    let projected: Outcome<unknown, unknown> | undefined;
    if (result.status === "completed" && !parent.snapshot.cancellationRequested) {
      const binding = bindings.get(link.childId);
      if (!binding || binding.program !== link.program) {
        throw new Error("Missing owned child result binding");
      }
      const selected = request.winner
        ? siblings.filter((child) => child.parent?.childId === request.winner)
        : siblings;
      if (!selected.length) {
        throw new Error("Missing race winner");
      }
      projected = binding.outcome(
        selected.map((child) => {
          if (child.snapshot.status !== "completed") {
            throw new Error("Incomplete owned group");
          }
          return child.snapshot.value;
        }),
      );
    }
    const pending = parent.snapshot.pending;
    parent.snapshot = settleOwnedChild(parent.snapshot, link, result, projected);
    if (projected && pending) {
      yield* records.append(link.parentId, {
        sequence: pending.sequence,
        receipt: link.requestId,
        request: pending.request,
        scope: pending.scope,
        outcome: projected,
      });
    }
    yield* records.set(link.parentId, parent);
  }

  return {
    // This is the sole heterogeneous record boundary. Typed handles are bound by
    // trusted program assembly, not inferred or validated from stored bytes.
    *read<R, Q, S>(id: string): Operation<JournalRecord<R, Q, S>, Y> {
      return (yield* record(records, id)) as JournalRecord<R, Q, S>;
    },
    *commit<R, Q, S, T>(id: string, next: JournalRecord<R, Q, S>, result: T): Operation<T, Y> {
      const previous = yield* record(records, id);
      const detached = next;
      yield* records.set(id, detached);
      if (previous.snapshot.status === "running" && detached.snapshot.status !== "running") {
        yield* settle(records, detached);
      }
      return result;
    },
    *cancel(id: string, requestId: string, reason: string) {
      return yield* cancel(records, id, requestId, reason);
    },
    *park<R, Q, S>(id: string, snapshot: JournalSnapshot<R, Q, S>, pending: PendingRequest<Q>) {
      const current = yield* record(records, id);
      current.snapshot = snapshot;
      yield* records.set(id, current);
      if (current.queuedStop !== undefined && !snapshot.cancellation) {
        const reason = current.queuedStop;
        current.queuedStop = undefined;
        yield* records.set(id, current);
        yield* cancel(records, id, pending.id, reason);
        return undefined;
      }
      return pending;
    },
    *acquire<C, V, E>(
      id: string,
      requestId: string,
      definition: OwnedChildrenOptions<C, V, E>,
    ): Operation<readonly ChildLink[], Y> {
      if (!definition.children.length) {
        throw new Error("Owned group must not be empty");
      }
      const parent = yield* record(records, id);
      const request = (yield* records.request(id, requestId)) ?? {};
      let links = request.children;
      if (links) {
        if (
          (request.join ?? "all") !== (definition.join ?? "all") ||
          links.length !== definition.children.length ||
          links.some((link, index) => {
            const child = definition.children[index]!;
            return link.program !== child.program || !options.equals(link.input, child.input);
          })
        ) {
          throw new Error("Owned child definition differs from recorded call");
        }
      } else {
        const state = parent.snapshot;
        if (state.status !== "running" || state.pending?.id !== requestId || state.children) {
          throw new Error("Stale or unknown child call boundary");
        }
        if (request.grant || request.registration) {
          throw new Error("Owned call excludes attempts and participant registration");
        }
        links = definition.children.map((child) => ({
          parentId: id,
          requestId,
          childId: crypto.randomUUID(),
          program: child.program,
          input: child.input,
        }));
        for (const link of links) {
          yield* records.set(link.childId, createJournalRecord(link.program, link));
        }
        yield* records.setRequest(id, requestId, {
          ...request,
          children: links,
          join: definition.join ?? "all",
        });
        yield* records.set(id, {
          ...parent,
          snapshot: { ...state, children: links, revision: state.revision + 1 },
        });
      }
      for (const link of links) {
        if (!bindings.has(link.childId)) {
          bindings.set(link.childId, {
            program: link.program,
            outcome: definition.outcome as (
              values: readonly unknown[],
            ) => Outcome<unknown, unknown>,
          });
        }
      }
      return links;
    },
  };
}
