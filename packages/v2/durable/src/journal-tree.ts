import { requestJournalCancellation, settleOwnedChild } from "./transitions.ts";
import type { Outcome, Operation } from "@standard-durability/core";
import type {
  ChildLink,
  JournalSnapshot,
  PendingRequest,
  OwnedChildOptions,
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

/** Prepare the entire eligible descendant chain before publishing any cancellation. */
function* cancel<Y>(records: JournalRecords<Y>, id: string, requestId: string, reason: string) {
  let currentId = id;
  let current = yield* record(records, currentId);
  let boundary = requestId;
  let root: ReturnType<typeof requestJournalCancellation> | undefined;
  while (true) {
    // Owned calls exclude attempt/participant authority; their link is already on the head.
    const request =
      current.snapshot.status === "running" && current.snapshot.child
        ? undefined
        : yield* records.request(currentId, boundary);
    const decision = requestJournalCancellation(current.snapshot, boundary, reason, request?.grant);
    root ??= decision;
    current.snapshot = decision.snapshot;
    yield* records.set(currentId, current);
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
      yield* records.setRequest(currentId, boundary, request);
    }
    if (!decision.childToCancel) {
      return root.cancellation;
    }
    currentId = decision.childToCancel.childId;
    current = yield* record(records, currentId);
    const snapshot = current.snapshot;
    if (snapshot.status !== "running" || snapshot.cancellation || snapshot.cancellationRequested) {
      return root.cancellation;
    }
    if (!snapshot.pending) {
      current.queuedStop ??= reason;
      yield* records.set(currentId, current);
      return root.cancellation;
    }
    boundary = snapshot.pending.id;
  }
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
    const parent = yield* record(records, link.parentId);
    let projected: Outcome<unknown, unknown> | undefined;
    if (
      next.snapshot.status === "completed" &&
      !(parent.snapshot.status === "running" && parent.snapshot.cancellationRequested)
    ) {
      const binding = bindings.get(link.childId);
      if (!binding || binding.program !== link.program) {
        throw new Error("Missing owned child result binding");
      }
      projected = binding.outcome(next.snapshot.value);
    }
    const pending = parent.snapshot.status === "running" ? parent.snapshot.pending : undefined;
    parent.snapshot = settleOwnedChild(parent.snapshot, link, next.snapshot, projected);
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
      definition: OwnedChildOptions<C, V, E>,
    ): Operation<ChildLink, Y> {
      const outcome = definition.outcome;
      const parent = yield* record(records, id);
      const request = (yield* records.request(id, requestId)) ?? {};
      const existing = request.child;
      let link: ChildLink;
      if (existing) {
        if (
          existing.program !== definition.program ||
          !options.equals(existing.input, definition.input)
        ) {
          throw new Error("Owned child definition differs from recorded call");
        }
        link = existing;
      } else {
        const state = parent.snapshot;
        if (state.status !== "running" || state.pending?.id !== requestId || state.child) {
          throw new Error("Stale or unknown child call boundary");
        }
        if (request.grant || request.registration) {
          throw new Error("Owned call excludes attempts and participant registration");
        }
        link = {
          parentId: id,
          requestId,
          childId: crypto.randomUUID(),
          program: definition.program,
          input: definition.input,
        };
        yield* records.set(link.childId, createJournalRecord(link.program, link));
        yield* records.setRequest(id, requestId, { ...request, child: link });
        parent.snapshot = { ...state, child: link, revision: state.revision + 1 };
        yield* records.set(id, parent);
      }
      // Bindings are staged alongside the decision and retained only after commit.
      // Reacquisition retains the original trusted projection for this pinned call.
      if (!bindings.has(link.childId)) {
        bindings.set(link.childId, {
          program: link.program,
          outcome: outcome as (value: unknown) => Outcome<unknown, unknown>,
        });
      }
      return link;
    },
  };
}
