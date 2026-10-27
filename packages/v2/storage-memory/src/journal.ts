import type {
  Journal,
  JournalSnapshot,
  Accepted,
  PendingRequest,
  Attempts,
  AttemptGrant,
  Interactions,
  InteractionRegistration,
  ResolutionGrant,
} from "@sweatpan.ts/durable";
import type { MemoryJournalOptions } from "./contracts.ts";

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
): Journal<R, Q, V, E, S, never> & {
  readonly attempts: Attempts<Q, V, E, never>;
  readonly interactions: Interactions<Q, V, E, never>;
} {
  const identity = crypto.randomUUID();
  let state: JournalSnapshot<R, Q, V, E, S> = {
    program: options.program,
    revision: 0,
    history: [],
    status: "running",
  };
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
    const entry: Accepted<Q, V, E> = structuredClone({
      sequence: state.pending.sequence,
      receipt: id,
      request: state.pending.request,
      outcome,
    });
    const { pending: _pending, ...rest } = state;
    state = { ...rest, revision: state.revision + 1, history: [...state.history, entry] };
    return { entry: structuredClone(entry), duplicate: false };
  };
  return {
    interactions: {
      *register(requestId) {
        if (state.status !== "running" || state.pending?.id !== requestId) {
          throw new Error("Stale or unknown pending request");
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
        if (registrations.has(requestId)) {
          throw new Error("Participant registration excludes executing attempts");
        }
        const previous = grants.get(requestId);
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
        const currentGrant = grants.get(grant.requestId);
        if (!currentGrant || !sameGrant(currentGrant, grant)) {
          throw new Error("Stale attempt grant");
        }
        return yield* accept(grant.requestId, outcome);
      },
    },
    *read() {
      return structuredClone(state);
    },
    *park(revision, request, checkpoint) {
      const snapshot = current(revision);
      if (snapshot.pending && !options.equals(snapshot.pending.request, request)) {
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
        id: `${identity}:${snapshot.history.length}`,
        sequence: snapshot.history.length,
        request,
      };
      // Clone before publishing: neither caller mutation nor clone failure can partially commit.
      const next = structuredClone({
        ...snapshot,
        revision: snapshot.revision + 1,
        pending,
        checkpoint: checkpoint ?? snapshot.checkpoint,
      });
      state = next;
      return structuredClone(next.pending);
    },
    accept,
    *complete(revision, value) {
      const snapshot = current(revision);
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
      state = next;
    },
  };
}
