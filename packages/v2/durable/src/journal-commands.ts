import { JournalConflict } from "./conflict.ts";
import type { AcceptanceTransition } from "./types.ts";
import type { Operation } from "@standard-durability/core";
import { acceptJournalOutcome, settleJournalAttempt } from "./acceptance.ts";
import type {
  Accepted,
  AttemptState,
  JournalSnapshot,
  AttemptGrant,
  ResolutionGrant,
  JournalBindingOptions,
  JournalRecords,
  OwnedJournal,
  RootCancellation,
} from "./contracts.ts";
import { createJournalTree } from "./journal-tree.ts";

/** Commands load only current state and the request facts needed by their decision. */
export function createJournalCommands<R, Q, V, E, S, Y>(
  options: JournalBindingOptions,
  tree: ReturnType<typeof createJournalTree<Y>>,
  records: JournalRecords<Y>,
  identity: string,
): Omit<OwnedJournal<R, Q, V, E, S, Y>, "ensureChild" | "ensureChildren" | "read"> & {
  read(): Operation<JournalSnapshot<R, Q, S>, Y>;
} {
  const read = () => tree.read<R, Q, S>(identity);
  function* commit<T>(snapshot: JournalSnapshot<R, Q, S>, result: T): Operation<T, Y> {
    const record = yield* read();
    return yield* tree.commit(identity, { ...record, snapshot }, result);
  }
  function* accepted(receipt: string) {
    return (yield* records.accepted(identity, receipt)) as Accepted<Q, V, E> | undefined;
  }
  function* publish(decision: AcceptanceTransition<R, Q, V, E, S>) {
    if (!decision.acceptance.duplicate) {
      yield* records.append(identity, decision.acceptance.entry);
      yield* commit(decision.snapshot, undefined);
    }
    return decision.acceptance;
  }
  function sameGrant(left: AttemptGrant, right: AttemptGrant) {
    return (
      left.requestId === right.requestId &&
      left.attemptId === right.attemptId &&
      left.retrySafety === right.retrySafety
    );
  }
  function* registered(grant: ResolutionGrant) {
    const request = (yield* records.request(identity, grant.requestId)) ?? {};
    const registration = request.registration;
    if (!registration || registration.grant.resolutionId !== grant.resolutionId) {
      throw new Error("Unknown resolution authority");
    }
    return { request, registration };
  }
  function* inspect(grant: AttemptGrant): Operation<AttemptState<Q, V, E>, Y> {
    const request = yield* records.request(identity, grant.requestId);
    if (!request?.grant || !sameGrant(request.grant, grant)) {
      throw new Error("Stale attempt grant");
    }
    if (request.revoked !== undefined) {
      return { state: "invalidated", reason: request.revoked };
    }
    const prior = yield* accepted(grant.requestId);
    return prior
      ? { state: "accepted", acceptance: { entry: prior, duplicate: true } }
      : { state: "active" };
  }
  function* current(revision: number) {
    const { snapshot: state } = yield* read();
    if (revision !== state.revision) {
      throw new JournalConflict("Journal revision conflict");
    }
    if (state.status !== "running") {
      throw new Error("Journal already completed");
    }
    return state;
  }
  const accept: OwnedJournal<R, Q, V, E, S, Y>["accept"] = function* (id, outcome) {
    const { snapshot } = yield* read();
    const prior = yield* accepted(id);
    return yield* publish(acceptJournalOutcome(snapshot, id, outcome, options.equals, prior));
  };
  return {
    id: identity,
    *admit(program, input) {
      const record = yield* read();
      const { snapshot } = record;
      if (program !== snapshot.program) {
        throw new Error("Admission program mismatch");
      }
      if (record.parent) {
        throw new Error("Owned child input is pinned by its parent");
      }
      if (snapshot.admission) {
        if (!options.equals(snapshot.admission.input, input)) {
          throw new Error("Conflicting invocation input");
        }
        return snapshot.admission.input;
      }
      if (snapshot.status !== "running" || snapshot.revision !== 0) {
        throw new Error("Admission requires an unstarted journal");
      }
      return yield* commit(
        { ...snapshot, admission: { input }, revision: snapshot.revision + 1 },
        input,
      );
    },
    cancellation: {
      *request(requestId, reason) {
        return (yield* tree.cancel(identity, requestId, reason)) as RootCancellation<Q>;
      },
      *finish(revision, failure) {
        const snapshot = yield* current(revision);
        if (!snapshot.cancellation || snapshot.pending) {
          throw new Error("Cancellation completion requires drained cleanup");
        }
        const {
          children: _children,
          cancellationRequested: _requested,
          pending: _pending,
          ...settled
        } = snapshot;
        yield* commit(
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
      inspect,
      *invalidate(grant, reason) {
        const prior = yield* inspect(grant);
        if (prior.state !== "active") {
          return prior;
        }
        const request = (yield* records.request(identity, grant.requestId))!;
        yield* records.setRequest(identity, grant.requestId, { ...request, revoked: reason });
        const { snapshot } = yield* read();
        return yield* commit(
          { ...snapshot, revision: snapshot.revision + 1 },
          { state: "invalidated" as const, reason },
        );
      },
    },
    interactions: {
      *request(grant) {
        const { registration } = yield* registered(grant);
        if (registration.state === "invalidated") {
          throw new Error("Resolution authority revoked");
        }
        const prior = yield* accepted(grant.requestId);
        if (prior) {
          return prior.request;
        }
        const { snapshot } = yield* read();
        if (snapshot.status !== "running" || snapshot.pending?.id !== grant.requestId) {
          throw new Error("Stale or unknown pending request");
        }
        return snapshot.pending.request;
      },
      *register(requestId) {
        const { snapshot: state } = yield* read();
        if (state.status !== "running" || state.pending?.id !== requestId) {
          throw new JournalConflict("Stale or unknown pending request");
        }
        if (state.children) {
          throw new Error("Owned call excludes participant registration");
        }
        const request = (yield* records.request(identity, requestId)) ?? {};
        if (request.grant) {
          throw new Error("Executing attempt excludes participant registration");
        }
        if (request.registration) {
          return request.registration;
        }
        const registration = {
          state: "waiting" as const,
          grant: { requestId, resolutionId: crypto.randomUUID() },
        };
        yield* records.setRequest(identity, requestId, { ...request, registration });
        return yield* commit({ ...state, revision: state.revision + 1 }, registration);
      },
      *answer(grant, outcome) {
        const { registration } = yield* registered(grant);
        if (registration.state === "invalidated") {
          throw new Error("Resolution authority revoked");
        }
        return yield* accept(grant.requestId, outcome);
      },
      *invalidate(grant, reason) {
        const { request, registration } = yield* registered(grant);
        if (registration.state === "invalidated") {
          return { state: "invalidated", reason: registration.reason };
        }
        const prior = yield* accepted(grant.requestId);
        if (prior) {
          return { state: "accepted", acceptance: { entry: prior, duplicate: true } };
        }
        const { snapshot: state } = yield* read();
        if (state.status !== "running" || state.pending?.id !== grant.requestId) {
          throw new Error("Stale or unknown pending request");
        }
        yield* records.setRequest(identity, grant.requestId, {
          ...request,
          registration: { state: "invalidated", grant: registration.grant, reason },
        });
        return yield* commit(
          { ...state, revision: state.revision + 1 },
          { state: "invalidated" as const, reason },
        );
      },
    },
    attempts: {
      *begin(requestId, retrySafety, replace) {
        const { snapshot: state } = yield* read();
        if (state.status !== "running" || state.pending?.id !== requestId) {
          throw new JournalConflict("Stale or unknown pending request");
        }
        if (state.children) {
          throw new Error("Owned call excludes executing attempts");
        }
        const request = (yield* records.request(identity, requestId)) ?? {};
        if (request.registration) {
          throw new Error("Participant registration excludes executing attempts");
        }
        const previous = request.grant;
        if (previous && request.revoked !== undefined) {
          if (replace) {
            throw new Error("Invalidated attempt cannot be replaced");
          }
          return { state: "invalidated", grant: previous, reason: request.revoked };
        }
        if (replace) {
          if (!previous || !sameGrant(previous, replace)) {
            throw new Error("Attempt replacement conflict");
          }
          if (previous.retrySafety !== "repeatable" || retrySafety !== "repeatable") {
            throw new Error("Unsafe attempt cannot be retried");
          }
        } else if (previous) {
          return { state: "occupied", grant: previous };
        }
        const grant = { requestId, attemptId: crypto.randomUUID(), retrySafety };
        yield* records.setRequest(identity, requestId, { ...request, grant });
        return yield* commit(
          { ...state, revision: state.revision + 1 },
          { state: "granted" as const, grant },
        );
      },
      *settle(grant, outcome) {
        const { snapshot } = yield* read();
        const request = yield* records.request(identity, grant.requestId);
        // All reads and publication share this transaction, including absence checks.
        const prior = yield* accepted(grant.requestId);
        return yield* publish(
          settleJournalAttempt(
            snapshot,
            { current: request?.grant, revoked: request?.revoked },
            grant,
            outcome,
            options.equals,
            prior,
          ),
        );
      },
    },
    *read() {
      return (yield* read()).snapshot;
    },
    *park(revision, request, checkpoint, scope) {
      const snapshot = yield* current(revision);
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
          checkpoint.position !== snapshot.frontier.position ||
          checkpoint.receipt !== snapshot.frontier.receipt)
      ) {
        throw new Error("Checkpoint differs from accepted journal position");
      }
      const pending = snapshot.pending ?? {
        id: `${identity}:${snapshot.frontier.position}${snapshot.cancellation ? ":cleanup" : ""}`,
        sequence: snapshot.frontier.position,
        request,
        scope,
      };
      return yield* tree.park(
        identity,
        {
          ...snapshot,
          revision: snapshot.revision + 1,
          pending,
          checkpoint: checkpoint ?? snapshot.checkpoint,
        },
        pending,
      );
    },
    accept,
    *complete(revision, value) {
      const snapshot = yield* current(revision);
      if (snapshot.cancellation) {
        throw new Error("Cannot complete successfully after root cancellation");
      }
      if (snapshot.pending) {
        throw new Error("Cannot complete with an unanswered request");
      }
      yield* commit(
        {
          program: snapshot.program,
          admission: snapshot.admission,
          revision: snapshot.revision + 1,
          frontier: snapshot.frontier,
          status: "completed",
          value,
        },
        undefined,
      );
    },
  };
}
