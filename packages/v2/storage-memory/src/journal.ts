import {
  acceptJournalOutcome,
  settleJournalAttempt,
  type RootCancellation,
  type AttemptState,
  type Journal,
  type JournalSnapshot,
  type PendingRequest,
  type AttemptGrant,
  type InteractionRegistration,
  type ResolutionGrant,
} from "@sweatpan.ts/durable";
import { createMemoryTree, createMemoryTreeData } from "./tree.ts";
import type {
  MemoryJournalOptions,
  MemoryJournal,
  MemoryChildOptions,
  MemoryJournalStore,
} from "./contracts.ts";

/**
 * Create a root journal and its process-local owned-tree transaction domain.
 * Attempt, interaction and child capabilities share that domain.
 * Mutations commit synchronously in one generator step; returned data is detached.
 * Stored values must support structuredClone. Equality applies to domain requests
 * and Outcomes; grant identity always uses exact field equality.
 *
 * @remarks State is lost with the process. This adapter does not establish database
 * durability, distributed leases, or exactly-once external effects.
 */
export function createMemoryJournal<R, Q, V, E, S = unknown>(
  options: MemoryJournalOptions,
): MemoryJournal<R, Q, V, E, S> {
  return createMemoryJournalStore<R, Q, V, E, S>(options).open();
}

/**
 * Create retained tree data independently of journal handles and projection bindings.
 * Each open starts fresh assembly; owned calls are rebound through ensureChild.
 * All opens share synchronous authority fencing and atomic owned-tree publication.
 */
export function createMemoryJournalStore<R, Q, V, E, S = unknown>(
  options: MemoryJournalOptions,
): MemoryJournalStore<R, Q, V, E, S> {
  const assembly = { ...options };
  const data = createMemoryTreeData(assembly.program);
  return {
    id: data.rootId,
    open() {
      const tree = createMemoryTree(assembly, data);
      return createJournal<R, Q, V, E, S>(assembly, tree, data.rootId);
    },
  };
}

function createJournal<R, Q, V, E, S>(
  options: MemoryJournalOptions,
  tree: ReturnType<typeof createMemoryTree>,
  identity: string,
): MemoryJournal<R, Q, V, E, S> {
  const read = () => tree.read<R, Q, V, E, S>(identity);
  function commit<T>(
    snapshot: JournalSnapshot<R, Q, V, E, S>,
    result: T,
    changes: {
      grants?: Map<string, AttemptGrant>;
      invalidated?: Map<string, string>;
      registrations?: Map<string, InteractionRegistration>;
      queuedStop?: string;
    } = {},
  ): T {
    return tree.commit(identity, { ...read(), ...changes, snapshot }, result);
  }
  function requestCancellation(requestId: string, reason: string): RootCancellation<Q> {
    return tree.cancel(identity, requestId, reason) as RootCancellation<Q>;
  }
  function sameGrant(left: AttemptGrant, right: AttemptGrant) {
    return (
      left.requestId === right.requestId &&
      left.attemptId === right.attemptId &&
      left.retrySafety === right.retrySafety
    );
  }
  function registered(grant: ResolutionGrant) {
    const { registrations } = read();
    const registration = registrations.get(grant.requestId);
    if (!registration || registration.grant.resolutionId !== grant.resolutionId) {
      throw new Error("Unknown resolution authority");
    }
    return registration;
  }
  function inspect(grant: AttemptGrant): AttemptState<Q, V, E> {
    const { snapshot: state, grants, invalidated } = read();
    const currentGrant = grants.get(grant.requestId);
    if (!currentGrant || !sameGrant(currentGrant, grant)) {
      throw new Error("Stale attempt grant");
    }
    const reason = invalidated.get(grant.attemptId);
    if (reason !== undefined) {
      return { state: "invalidated", reason };
    }
    const prior = state.history.find((entry) => entry.receipt === grant.requestId);
    return prior
      ? { state: "accepted", acceptance: { entry: structuredClone(prior), duplicate: true } }
      : { state: "active" };
  }
  function current(revision: number) {
    const { snapshot: state } = read();
    if (revision !== state.revision) {
      throw new Error("Journal revision conflict");
    }
    if (state.status !== "running") {
      throw new Error("Journal already completed");
    }
    return state;
  }
  const accept: Journal<R, Q, V, E, S, never>["accept"] = function* (id, outcome) {
    const { snapshot: state } = read();
    const decision = acceptJournalOutcome(state, id, outcome, options.equals);
    return commit(decision.snapshot, decision.acceptance);
  };
  const journal: MemoryJournal<R, Q, V, E, S> = {
    id: identity,
    *ensureChild<C, CQ, CV, CE, CS = unknown>(
      requestId: string,
      definition: MemoryChildOptions<C, V, E>,
    ) {
      const link = tree.acquire(identity, requestId, definition);
      return {
        link,
        journal: createJournal<C, CQ, CV, CE, CS>(
          { program: definition.program, equals: options.equals },
          tree,
          link.childId,
        ),
      };
    },
    cancellation: {
      *request(requestId, reason) {
        return requestCancellation(requestId, reason);
      },
      *finish(revision, failure) {
        const snapshot = current(revision);
        if (!snapshot.cancellation || snapshot.pending) {
          throw new Error("Cancellation completion requires drained cleanup");
        }
        const {
          child: _child,
          cancellationRequested: _requested,
          pending: _pending,
          ...settled
        } = snapshot;
        commit(
          {
            ...settled,
            revision: snapshot.revision + 1,
            status: "cancelled",
            reason: snapshot.cancellation.reason,
            failure: failure ?? snapshot.cancellation.failure,
          },
          undefined,
        );
      },
    },
    attemptControl: {
      *inspect(grant) {
        return inspect(grant);
      },
      *invalidate(grant, reason) {
        const { snapshot: state, invalidated, queuedStop } = read();
        const prior = inspect(grant);
        if (prior.state !== "active") {
          return prior;
        }
        return commit(
          { ...state, revision: state.revision + 1 },
          { state: "invalidated" as const, reason },
          { invalidated: new Map(invalidated).set(grant.attemptId, reason), queuedStop },
        );
      },
    },
    interactions: {
      *register(requestId) {
        const { snapshot: state, grants, registrations, queuedStop } = read();
        if (state.status !== "running" || state.pending?.id !== requestId) {
          throw new Error("Stale or unknown pending request");
        }
        if (state.child) {
          throw new Error("Owned call excludes participant registration");
        }
        if (grants.has(requestId)) {
          throw new Error("Executing attempt excludes participant registration");
        }
        const existing = registrations.get(requestId);
        if (existing) {
          return structuredClone(existing);
        }
        const registration: InteractionRegistration = {
          state: "waiting",
          grant: { requestId, resolutionId: crypto.randomUUID() },
        };
        return commit({ ...state, revision: state.revision + 1 }, registration, {
          registrations: new Map(registrations).set(requestId, registration),
          queuedStop,
        });
      },
      *answer(grant, outcome) {
        const registration = registered(grant);
        if (registration.state === "invalidated") {
          throw new Error("Resolution authority revoked");
        }
        return yield* accept(grant.requestId, outcome);
      },
      *invalidate(grant, reason) {
        const { snapshot: state, registrations, queuedStop } = read();
        const registration = registered(grant);
        if (registration.state === "invalidated") {
          return { state: "invalidated", reason: registration.reason };
        }
        const prior = state.history.find((entry) => entry.receipt === grant.requestId);
        if (prior) {
          return {
            state: "accepted",
            acceptance: { entry: structuredClone(prior), duplicate: true },
          };
        }
        if (state.status !== "running" || state.pending?.id !== grant.requestId) {
          throw new Error("Stale or unknown pending request");
        }
        return commit(
          { ...state, revision: state.revision + 1 },
          { state: "invalidated" as const, reason },
          {
            registrations: new Map(registrations).set(grant.requestId, {
              state: "invalidated",
              grant: registration.grant,
              reason,
            }),
            queuedStop,
          },
        );
      },
    },
    attempts: {
      *begin(requestId, retrySafety, replace) {
        const { snapshot: state, grants, invalidated, registrations, queuedStop } = read();
        if (state.status !== "running" || state.pending?.id !== requestId) {
          throw new Error("Stale or unknown pending request");
        }
        if (state.child) {
          throw new Error("Owned call excludes executing attempts");
        }
        if (registrations.has(requestId)) {
          throw new Error("Participant registration excludes executing attempts");
        }
        const previous = grants.get(requestId);
        if (previous && invalidated.has(previous.attemptId)) {
          if (replace) {
            throw new Error("Invalidated attempt cannot be replaced");
          }
          return {
            state: "invalidated",
            grant: structuredClone(previous),
            reason: invalidated.get(previous.attemptId)!,
          };
        }
        if (replace) {
          if (!previous || !sameGrant(previous, replace)) {
            throw new Error("Attempt replacement conflict");
          }
          if (previous.retrySafety !== "repeatable" || retrySafety !== "repeatable") {
            throw new Error("Unsafe attempt cannot be retried");
          }
        } else if (previous) {
          return { state: "occupied", grant: structuredClone(previous) };
        }
        const grant: AttemptGrant = { requestId, attemptId: crypto.randomUUID(), retrySafety };
        return commit(
          { ...state, revision: state.revision + 1 },
          { state: "granted" as const, grant },
          { grants: new Map(grants).set(requestId, grant), queuedStop },
        );
      },
      *settle(grant, outcome) {
        const { snapshot: state, grants, invalidated } = read();
        // Eligibility and acceptance run synchronously with no inspect RPC or yield.
        const decision = settleJournalAttempt(
          state,
          { current: grants.get(grant.requestId), revoked: invalidated.get(grant.attemptId) },
          grant,
          outcome,
          options.equals,
        );
        return commit(decision.snapshot, decision.acceptance);
      },
    },
    *read() {
      const { snapshot: state } = read();
      return structuredClone(state);
    },
    *park(revision, request, checkpoint, scope) {
      const snapshot = current(revision);
      if (
        snapshot.pending &&
        (!options.equals(snapshot.pending.request, request) ||
          !options.equals(snapshot.pending.scope, scope))
      ) {
        throw new Error("Pending request differs from recovered request");
      }
      if (
        checkpoint &&
        (checkpoint.program !== snapshot.program ||
          checkpoint.position !== snapshot.history.length ||
          checkpoint.receipt !==
            (snapshot.history.length
              ? snapshot.history[snapshot.history.length - 1]!.receipt
              : null))
      ) {
        throw new Error("Checkpoint differs from accepted journal position");
      }
      const pending: PendingRequest<Q> = snapshot.pending ?? {
        id: `${identity}:${snapshot.history.length}${snapshot.cancellation ? ":cleanup" : ""}`,
        sequence: snapshot.history.length,
        request,
        scope,
      };
      // Clone before publishing: neither caller mutation nor clone failure can partially commit.
      const next = structuredClone({
        ...snapshot,
        revision: snapshot.revision + 1,
        pending,
        checkpoint: checkpoint ?? snapshot.checkpoint,
      });
      return tree.park(identity, next, next.pending);
    },
    accept,
    *complete(revision, value) {
      const snapshot = current(revision);
      if (snapshot.cancellation) {
        throw new Error("Cannot complete successfully after root cancellation");
      }
      if (snapshot.pending) {
        throw new Error("Cannot complete with an unanswered request");
      }
      const next = structuredClone({
        program: snapshot.program,
        revision: snapshot.revision + 1,
        history: snapshot.history,
        status: "completed" as const,
        value,
      });
      commit(next, undefined);
    },
  };
  return journal;
}
