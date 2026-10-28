import {
  requestJournalCancellation,
  settleOwnedChild,
  type RootCancellation,
  type ChildLink,
  type AttemptState,
  type Journal,
  type JournalSnapshot,
  type Accepted,
  type PendingRequest,
  type AttemptGrant,
  type InteractionRegistration,
  type ResolutionGrant,
} from "@sweatpan.ts/durable";
import type {
  MemoryJournalOptions,
  MemoryJournal,
  MemoryOwnedChild,
  MemoryChildOptions,
} from "./contracts.ts";

/**
 * Create one execution's process-local journal, attempt and interaction capabilities.
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
  return createJournal<R, Q, V, E, S>(options).journal;
}

function createJournal<R, Q, V, E, S>(
  options: MemoryJournalOptions,
  terminal?: (next: JournalSnapshot<R, Q, V, E, S>) => () => void,
  identity: string = crypto.randomUUID(),
): { journal: MemoryJournal<R, Q, V, E, S>; stop: (reason: string) => void } {
  let state: JournalSnapshot<R, Q, V, E, S> = {
    program: options.program,
    revision: 0,
    history: [],
    status: "running",
  };
  // Heterogeneous child contracts are erased only in this private registry.
  const children = new Map<
    string,
    { link: ChildLink; value: unknown; stop: (reason: string) => void }
  >();
  let queuedStop: string | undefined;
  function publish(next: JournalSnapshot<R, Q, V, E, S>) {
    const commitParent = next.status !== "running" ? terminal?.(next) : undefined;
    state = next;
    commitParent?.();
  }
  function stop(reason: string) {
    if (state.status !== "running" || state.cancellation || state.cancellationRequested) {
      return;
    }
    if (state.pending) {
      requestCancellation(state.pending.id, reason);
    } else {
      queuedStop ??= reason;
    }
  }
  function requestCancellation(requestId: string, reason: string): RootCancellation<Q> {
    const decision = requestJournalCancellation(state, requestId, reason, grants.get(requestId));
    // Validate and detach before publishing. No evaluator is called by this adapter.
    const next = structuredClone(decision.snapshot);
    const cancellation = structuredClone(decision.cancellation);
    const attempt = cancellation.attempt;
    if (decision.revoke) {
      if (attempt && !invalidated.has(attempt.attemptId)) {
        invalidated.set(attempt.attemptId, reason);
      }
      const registration = registrations.get(requestId);
      if (registration?.state === "waiting") {
        registrations.set(requestId, { state: "invalidated", grant: registration.grant, reason });
      }
    }
    state = next;
    if (decision.childToCancel) {
      children.get(requestId)!.stop(reason);
    }
    return cancellation;
  }

  function sameGrant(left: AttemptGrant, right: AttemptGrant) {
    return (
      left.requestId === right.requestId &&
      left.attemptId === right.attemptId &&
      left.retrySafety === right.retrySafety
    );
  }
  const registrations = new Map<string, InteractionRegistration>();
  function registered(grant: ResolutionGrant) {
    const registration = registrations.get(grant.requestId);
    if (!registration || registration.grant.resolutionId !== grant.resolutionId) {
      throw new Error("Unknown resolution authority");
    }
    return registration;
  }
  const grants = new Map<string, AttemptGrant>();
  const invalidated = new Map<string, string>();
  function inspect(grant: AttemptGrant): AttemptState<Q, V, E> {
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
    if (revision !== state.revision) {
      throw new Error("Journal revision conflict");
    }
    if (state.status !== "running") {
      throw new Error("Journal already completed");
    }
    return state;
  }
  const accept: Journal<R, Q, V, E, S, never>["accept"] = function* (id, outcome) {
    const prior = state.history.find((entry) => entry.receipt === id);
    if (prior) {
      if (!options.equals(prior.outcome, outcome)) {
        throw new Error("Conflicting accepted outcome");
      }
      return { entry: structuredClone(prior), duplicate: true };
    }
    if (state.status !== "running" || !state.pending || state.pending.id !== id) {
      throw new Error("Stale or unknown pending request");
    }
    if (state.child) {
      throw new Error("Owned call can only be accepted by child settlement");
    }
    const entry: Accepted<Q, V, E> = structuredClone({
      sequence: state.pending.sequence,
      receipt: id,
      request: state.pending.request,
      scope: state.pending.scope,
      outcome,
    });
    const { pending: _pending, ...rest } = state;
    state = { ...rest, revision: state.revision + 1, history: [...state.history, entry] };
    return { entry: structuredClone(entry), duplicate: false };
  };
  const journal: MemoryJournal<R, Q, V, E, S> = {
    id: identity,
    *ensureChild<C, CQ, CV, CE, CS = unknown>(
      requestId: string,
      definition: MemoryChildOptions<C, V, E>,
    ) {
      const existing = children.get(requestId);
      if (existing) {
        if (
          existing.link.program !== definition.program ||
          !options.equals(existing.link.input, definition.input)
        ) {
          throw new Error("Owned child definition differs from recorded call");
        }
        const stored = existing.value as MemoryOwnedChild<C, CQ, CV, CE, CS>;
        return { ...stored, link: structuredClone(existing.link) };
      }
      if (state.status !== "running" || state.pending?.id !== requestId || state.child) {
        throw new Error("Stale or unknown child call boundary");
      }
      if (grants.has(requestId) || registrations.has(requestId)) {
        throw new Error("Owned call excludes attempts and participant registration");
      }
      const link = structuredClone({
        parentId: identity,
        requestId,
        childId: crypto.randomUUID(),
        program: definition.program,
        input: definition.input,
      });
      const outcome = definition.outcome;
      const child = createJournal<C, CQ, CV, CE, CS>(
        { program: definition.program, equals: options.equals },
        (result) => {
          if (result.status === "running") {
            throw new Error("Child settlement requires terminal result");
          }
          const projected =
            result.status === "completed" &&
            !(state.status === "running" && state.cancellationRequested)
              ? outcome(result.value)
              : undefined;
          const next = structuredClone(settleOwnedChild(state, link, result, projected));
          // All projection/validation/cloning finishes before either journal publishes.
          return () => {
            state = next;
          };
        },
        link.childId,
      );
      const value: MemoryOwnedChild<C, CQ, CV, CE, CS> = {
        link: structuredClone(link),
        journal: child.journal,
      };
      children.set(requestId, { link, value, stop: child.stop });
      state = { ...state, child: link, revision: state.revision + 1 };
      return { ...value, link: structuredClone(link) };
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
        publish({
          ...settled,
          revision: snapshot.revision + 1,
          status: "cancelled",
          reason: snapshot.cancellation.reason,
          failure: failure ?? snapshot.cancellation.failure,
        });
      },
    },
    attemptControl: {
      *inspect(grant) {
        return inspect(grant);
      },
      *invalidate(grant, reason) {
        const prior = inspect(grant);
        if (prior.state !== "active") {
          return prior;
        }
        invalidated.set(grant.attemptId, reason);
        state = { ...state, revision: state.revision + 1 };
        return { state: "invalidated", reason };
      },
    },
    interactions: {
      *register(requestId) {
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
        registrations.set(requestId, registration);
        state = { ...state, revision: state.revision + 1 };
        return structuredClone(registration);
      },
      *answer(grant, outcome) {
        const registration = registered(grant);
        if (registration.state === "invalidated") {
          throw new Error("Resolution authority revoked");
        }
        return yield* accept(grant.requestId, outcome);
      },
      *invalidate(grant, reason) {
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
        registrations.set(grant.requestId, {
          state: "invalidated",
          grant: registration.grant,
          reason,
        });
        state = { ...state, revision: state.revision + 1 };
        return { state: "invalidated", reason };
      },
    },
    attempts: {
      *begin(requestId, retrySafety, replace) {
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
        grants.set(requestId, grant);
        state = { ...state, revision: state.revision + 1 };
        return { state: "granted", grant: structuredClone(grant) };
      },
      *settle(grant, outcome) {
        if (inspect(grant).state === "invalidated") {
          throw new Error("Attempt authority revoked");
        }
        return yield* accept(grant.requestId, outcome);
      },
    },
    *read() {
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
      state = next;
      if (queuedStop !== undefined && !state.cancellation) {
        requestCancellation(next.pending.id, queuedStop);
        queuedStop = undefined;
        return undefined;
      }
      return structuredClone(next.pending);
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
      publish(next);
    },
  };
  return { journal, stop };
}
