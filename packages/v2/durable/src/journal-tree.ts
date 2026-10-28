import { requestJournalCancellation, settleOwnedChild } from "./transitions.ts";
import type { Outcome } from "@standard-durability/core";
import type {
  ChildLink,
  JournalSnapshot,
  PendingRequest,
  OwnedChildOptions,
  JournalBindingOptions,
  JournalRecord,
  JournalRecords,
} from "./contracts.ts";
import type { ChildBinding } from "./types.ts";

/** Initial empty authority record; adapters store this with the pinned program. */
export function createJournalRecord(program: string, parent?: ChildLink): JournalRecord {
  return {
    snapshot: { program, revision: 0, history: [], status: "running" },
    grants: new Map(),
    invalidated: new Map(),
    registrations: new Map(),
    children: new Map(),
    parent,
  };
}

function record(records: JournalRecords, id: string): JournalRecord {
  const found = records.get(id);
  if (!found) {
    throw new Error("Unknown execution identity");
  }
  return found;
}

/** Prepare the entire eligible descendant chain before publishing any cancellation. */
function cancel(records: JournalRecords, id: string, requestId: string, reason: string) {
  let currentId = id;
  let current = record(records, currentId);
  let boundary = requestId;
  let root: ReturnType<typeof requestJournalCancellation> | undefined;
  while (true) {
    const decision = requestJournalCancellation(
      current.snapshot,
      boundary,
      reason,
      current.grants.get(boundary),
    );
    root ??= decision;
    current.snapshot = decision.snapshot;
    records.set(currentId, current);
    if (decision.revoke) {
      const attempt = decision.cancellation.attempt;
      if (attempt && !current.invalidated.has(attempt.attemptId)) {
        current.invalidated.set(attempt.attemptId, reason);
      }
      const registration = current.registrations.get(boundary);
      if (registration?.state === "waiting") {
        current.registrations.set(boundary, {
          state: "invalidated",
          grant: registration.grant,
          reason,
        });
      }
    }
    if (!decision.childToCancel) {
      return root.cancellation;
    }
    currentId = decision.childToCancel.childId;
    current = record(records, currentId);
    const snapshot = current.snapshot;
    if (snapshot.status !== "running" || snapshot.cancellation || snapshot.cancellationRequested) {
      return root.cancellation;
    }
    if (!snapshot.pending) {
      current.queuedStop ??= reason;
      records.set(currentId, current);
      return root.cancellation;
    }
    boundary = snapshot.pending.id;
  }
}

/** Transaction-local ownership decisions; bindings are supplied by the open assembly. */
export function createJournalTree(
  options: JournalBindingOptions,
  records: JournalRecords,
  bindings: Map<string, ChildBinding>,
) {
  const transact = <T>(decide: (draft: JournalRecords) => T): T => decide(records);
  function settle(records: JournalRecords, next: JournalRecord) {
    const link = next.parent;
    if (!link || next.snapshot.status === "running") {
      return;
    }
    const parent = record(records, link.parentId);
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
    parent.snapshot = settleOwnedChild(parent.snapshot, link, next.snapshot, projected);
    records.set(link.parentId, parent);
  }

  return {
    // This is the sole heterogeneous record boundary. Typed handles are bound by
    // trusted program assembly, not inferred or validated from stored bytes.
    read<R, Q, V, E, S>(id: string): JournalRecord<R, Q, V, E, S> {
      return record(records, id) as JournalRecord<R, Q, V, E, S>;
    },
    commit<R, Q, V, E, S, T>(id: string, next: JournalRecord<R, Q, V, E, S>, result: T): T {
      return transact((draft) => {
        const previous = record(draft, id);
        const detached = next;
        draft.set(id, detached);
        if (previous.snapshot.status === "running" && detached.snapshot.status !== "running") {
          settle(draft, detached);
        }
        return result;
      });
    },
    cancel(id: string, requestId: string, reason: string) {
      return transact((draft) => cancel(draft, id, requestId, reason));
    },
    park<R, Q, V, E, S>(
      id: string,
      snapshot: JournalSnapshot<R, Q, V, E, S>,
      pending: PendingRequest<Q>,
    ) {
      return transact((draft) => {
        const current = record(draft, id);
        current.snapshot = snapshot;
        draft.set(id, current);
        if (current.queuedStop !== undefined && !snapshot.cancellation) {
          const reason = current.queuedStop;
          current.queuedStop = undefined;
          cancel(draft, id, pending.id, reason);
          return undefined;
        }
        return pending;
      });
    },
    acquire<C, V, E>(
      id: string,
      requestId: string,
      definition: OwnedChildOptions<C, V, E>,
    ): ChildLink {
      const outcome = definition.outcome;
      const link = transact((draft) => {
        const parent = record(draft, id);
        const existing = parent.children.get(requestId);
        if (existing) {
          if (
            existing.program !== definition.program ||
            !options.equals(existing.input, definition.input)
          ) {
            throw new Error("Owned child definition differs from recorded call");
          }
          return existing;
        }
        const state = parent.snapshot;
        if (state.status !== "running" || state.pending?.id !== requestId || state.child) {
          throw new Error("Stale or unknown child call boundary");
        }
        if (parent.grants.has(requestId) || parent.registrations.has(requestId)) {
          throw new Error("Owned call excludes attempts and participant registration");
        }
        const link: ChildLink = {
          parentId: id,
          requestId,
          childId: crypto.randomUUID(),
          program: definition.program,
          input: definition.input,
        };
        draft.set(link.childId, createJournalRecord(link.program, link));
        parent.children.set(requestId, link);
        parent.snapshot = { ...state, child: link, revision: state.revision + 1 };
        draft.set(id, parent);
        return link;
      });
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
