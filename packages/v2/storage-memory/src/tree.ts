import type { Outcome } from "@standard-durability/core";
import {
  requestJournalCancellation,
  settleOwnedChild,
  type ChildLink,
  type JournalSnapshot,
  type PendingRequest,
} from "@sweatpan.ts/durable";
import type { MemoryChildOptions, MemoryJournalOptions } from "./contracts.ts";
import type { ChildBinding, MemoryRecord, MemoryTreeData } from "./types.ts";
import { transactMemory } from "./transaction.ts";

function createRecord(program: string, parent?: ChildLink): MemoryRecord {
  return {
    snapshot: { program, revision: 0, history: [], status: "running" },
    grants: new Map(),
    invalidated: new Map(),
    registrations: new Map(),
    children: new Map(),
    parent,
  };
}

function record(records: Map<string, MemoryRecord>, id: string): MemoryRecord {
  const found = records.get(id);
  if (!found) {
    throw new Error("Unknown execution identity");
  }
  return found;
}

/** Prepare the entire eligible descendant chain before publishing any cancellation. */
function cancel(records: Map<string, MemoryRecord>, id: string, requestId: string, reason: string) {
  let current = record(records, id);
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
    current = record(records, decision.childToCancel.childId);
    const snapshot = current.snapshot;
    if (snapshot.status !== "running" || snapshot.cancellation || snapshot.cancellationRequested) {
      return root.cancellation;
    }
    if (!snapshot.pending) {
      current.queuedStop ??= reason;
      return root.cancellation;
    }
    boundary = snapshot.pending.id;
  }
}

/** Retain only data across assemblies. */
export function createMemoryTreeData(program: string): MemoryTreeData {
  const rootId = crypto.randomUUID();
  return { rootId, records: new Map([[rootId, createRecord(program)]]) };
}

/** Fresh assembly bindings over one shared process-local transaction domain. */
export function createMemoryTree(options: MemoryJournalOptions, data: MemoryTreeData) {
  const bindings = new Map<string, ChildBinding>();

  function transact<T>(decide: (draft: Map<string, MemoryRecord>) => T): T {
    return transactMemory(
      () => {
        const draft = structuredClone(data.records);
        const result = decide(draft);
        return { state: draft, result };
      },
      (next) => {
        data.records = next;
      },
    );
  }

  function settle(records: Map<string, MemoryRecord>, next: MemoryRecord) {
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
  }

  return {
    rootId: data.rootId,
    // This is the sole heterogeneous record boundary. Typed handles are bound by
    // trusted program assembly, not inferred or validated from stored bytes.
    read<R, Q, V, E, S>(id: string): MemoryRecord<R, Q, V, E, S> {
      return record(data.records, id) as MemoryRecord<R, Q, V, E, S>;
    },
    commit<R, Q, V, E, S, T>(id: string, next: MemoryRecord<R, Q, V, E, S>, result: T): T {
      return transact((draft) => {
        const previous = record(draft, id);
        const detached = structuredClone(next);
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
        current.snapshot = structuredClone(snapshot);
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
      definition: MemoryChildOptions<C, V, E>,
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
        draft.set(link.childId, createRecord(link.program, link));
        parent.children.set(requestId, link);
        parent.snapshot = { ...state, child: link, revision: state.revision + 1 };
        return link;
      });
      // Binding installation cannot fail; validation/encoding completed before publication.
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
