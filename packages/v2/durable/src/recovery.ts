import type { Api, Composition, Operation, OperationMiddleware } from "@standard-durability/core";
import {
  createExecution,
  type Execution,
  type GuestWork,
  type ScopeBoundary,
  type CheckpointAdapter,
  type RestoredGuest,
} from "@sweatpan.ts/execution";
import type {
  Recovery,
  RootCancellation,
  Accepted,
  AcceptedHistory,
  Checkpoint,
  RecoveryMethods,
  RecoveryPlan,
} from "./contracts.ts";

function* validate<Q, V, E, S, Y>(program: string, plan: RecoveryPlan<Q, V, E, S, Y>) {
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

function* replay<R, Q, Y, V, E>(
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

/** Replay is the default. No handler is called during reconstruction. Scope owns disposal. */
export function createRecovery<R, Q, Y, V, E, S = unknown>(
  composition: Composition<Y>,
  options: {
    readonly name: string;
    readonly program: string;
    readonly acquire: GuestWork<R, Q, Y, V, E>;
    readonly matches: (actual: Q, accepted: Q) => boolean;
  },
): Recovery<R, Q, Y, V, E, S> {
  // Logical cancellation is applied once per live incarnation, not once per activation.
  const cancelled = new WeakSet<object>();
  const execution = createExecution<R, Q, Y, V, E>(composition, `${options.name}:execution`);
  const api: Api<RecoveryMethods<R, Q, Y, V, E, S>, Y> = composition.createApi<
    RecoveryMethods<R, Q, Y, V, E, S>
  >(options.name, {
    *recover(plan) {
      yield* validate(options.program, plan);
      const guest = yield* options.acquire();
      yield* execution.install(guest);
      const turn = yield* execution.operations.start();
      return yield* api.operations.advance(
        { guest, turn, program: options.program, position: 0, receipt: null },
        plan,
      );
    },
    *advance(current, plan) {
      yield* validate(options.program, plan);
      const position = current.position;
      if (
        current.program !== options.program ||
        !Number.isSafeInteger(position) ||
        position < 0 ||
        position > plan.history.end.position
      ) {
        throw new Error("Live Guest differs from accepted history");
      }
      const receipt = position === 0 ? null : (yield* plan.history.at(position - 1))?.receipt;
      if (current.receipt !== receipt) {
        throw new Error("Live Guest differs from accepted history");
      }
      const advanced = yield* replay(
        current,
        execution.operations,
        plan.history,
        position,
        options.matches,
        plan.cancellation,
        cancelled.has(current.guest),
      );
      if (advanced.cancellationApplied) {
        cancelled.add(advanced.guest);
      }
      return {
        guest: advanced.guest,
        turn: advanced.turn,
        program: options.program,
        ...plan.history.end,
      };
    },
    *checkpoint() {
      return undefined;
    },
  });
  return { ...api, execution };
}

/** Unsupported formats delegate before acquisition. Errors from a supported restore propagate. */
export function createCheckpointMiddleware<R, Q, Y, V, E, S>(options: {
  readonly program: string;
  readonly adapter: CheckpointAdapter<R, Q, Y, V, E, S>;
  /** The same scoped API used by fresh recovery; restores install its driver too. */
  readonly execution: Execution<R, Q, Y, V, E>;
  readonly matches: (actual: Q, accepted: Q) => boolean;
}): OperationMiddleware<RecoveryMethods<R, Q, Y, V, E, S>> {
  const { program, adapter, matches } = options;
  return {
    *recover([plan], next) {
      const saved = plan.checkpoint;
      if (plan.cancellation || !saved || saved.format !== adapter.format) {
        return yield* next(plan);
      }
      yield* validate(program, plan);
      const restored = yield* adapter.restore(saved.state);
      yield* options.execution.install(restored.guest);
      const result = yield* replay(
        restored,
        options.execution.operations,
        plan.history,
        saved.position,
        matches,
      );
      return { ...result, program, ...plan.history.end };
    },
    *checkpoint([recovered, position], next) {
      if (recovered.program !== program || recovered.position !== position.position) {
        throw new Error("Checkpoint position differs from accepted history");
      }
      if (recovered.turn.kind !== "suspended") {
        return yield* next(recovered, position);
      }
      const state = yield* adapter.capture(recovered.guest);
      if (state === undefined) {
        return yield* next(recovered, position);
      }
      return {
        program,
        format: adapter.format,
        position: position.position,
        receipt: position.receipt,
        state,
      } satisfies Checkpoint<S>;
    },
  };
}
