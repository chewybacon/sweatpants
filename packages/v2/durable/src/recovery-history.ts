import type { Operation } from "@standard-durability/core";
import type { Execution, ScopeBoundary, RestoredGuest } from "@sweatpan.ts/execution";
import type { RootCancellation, Accepted, AcceptedHistory, RecoveryPlan } from "./contracts.ts";

export function* validate<Q, V, E, S, Y>(program: string, plan: RecoveryPlan<Q, V, E, S, Y>) {
  const end = plan.history.end;
  if (
    !Number.isSafeInteger(end.position) ||
    end.position < 0 ||
    (end.position === 0 ? end.receipt !== null : !end.receipt)
  ) {
    throw new Error("Invalid accepted history frontier");
  }
  if (
    plan.cancellation &&
    (!Number.isSafeInteger(plan.cancellation.position) ||
      plan.cancellation.position < 0 ||
      plan.cancellation.position > end.position)
  ) {
    throw new Error("Invalid cancellation position");
  }
  const saved = plan.checkpoint;
  if (saved) {
    if (
      saved.program !== program ||
      !Number.isSafeInteger(saved.position) ||
      saved.position < 0 ||
      saved.position > end.position ||
      saved.receipt !==
        (saved.position === 0
          ? null
          : saved.position === end.position
            ? end.receipt
            : (yield* plan.history.at(saved.position - 1))?.receipt)
    ) {
      throw new Error("Checkpoint does not match accepted history");
    }
  }
}

function sameScope(actual: ScopeBoundary | undefined, expected: ScopeBoundary | undefined) {
  return (
    actual?.scopeId === expected?.scopeId &&
    actual?.frameId === expected?.frameId &&
    actual?.phase === expected?.phase &&
    actual?.critical === expected?.critical
  );
}

export function* replay<R, Q, Y, V, E>(
  initial: RestoredGuest<R, Q, Y, V, E>,
  operations: Execution<R, Q, Y, V, E>["operations"],
  history: AcceptedHistory<Q, V, E, Y>,
  position: number,
  matches: (actual: Q, accepted: Q) => boolean,
  cancellation?: RootCancellation<Q>,
  cancellationApplied = false,
): Operation<RestoredGuest<R, Q, Y, V, E> & { cancellationApplied: boolean }, Y> {
  let turn = initial.turn;
  let page: readonly Accepted<Q, V, E>[] = [];
  let offset = 0;
  for (let index = position; index <= history.end.position; index++) {
    if (!cancellationApplied && cancellation?.position === index) {
      if (
        turn.kind !== "suspended" ||
        !matches(turn.request, cancellation.request) ||
        !sameScope(turn.scope, cancellation.scope)
      ) {
        throw new Error("Replay cancellation boundary mismatch");
      }
      turn = yield* operations.cancel(cancellation.reason);
      cancellationApplied = true;
    }
    if (index === history.end.position) {
      break;
    }
    if (offset === page.length) {
      page = yield* history.read(index, 128);
      if (page.length > Math.min(128, history.end.position - index)) {
        throw new Error("Invalid accepted history page");
      }
      offset = 0;
    }
    const entry = page[offset++];
    if (
      !entry ||
      entry.sequence !== index ||
      !entry.receipt ||
      (index === history.end.position - 1 && entry.receipt !== history.end.receipt)
    ) {
      throw new Error("Invalid accepted history");
    }
    if (
      turn.kind !== "suspended" ||
      !matches(turn.request, entry.request) ||
      !sameScope(turn.scope, entry.scope)
    ) {
      throw new Error(`Replay request mismatch at ${entry.sequence}`);
    }
    turn = yield* operations.resume(entry.outcome);
  }
  return { guest: initial.guest, turn, cancellationApplied };
}
