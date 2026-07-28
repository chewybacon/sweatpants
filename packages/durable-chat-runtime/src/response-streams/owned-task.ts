import { call, createScope, type Operation, type Scope } from "effection";

/** Minimal task surface retained by the stream registry and Host supervisor. */
export interface OwnedTaskHandle<T = void> {
  readonly status: () => OwnedTaskStatus;
  readonly result: () => T | undefined;
  readonly error: () => Error | undefined;
  readonly isDone: () => boolean;
  readonly waitForDone: () => Operation<OwnedTaskStatus>;
  readonly halt: () => Operation<void>;
}

export type OwnedTaskStatus = "pending" | "running" | "complete" | "error" | "halted";

export interface OwnedTaskOptions<T = void> {
  /** Explicit Host/Turn owner. The task is a child of this scope when supplied. */
  readonly ownerScope?: Scope;
  /** Registers the task with the owner’s shutdown supervisor. */
  readonly register?: (task: OwnedTaskHandle<T>) => void;
}

/**
 * Starts work in a reclaimable child scope without inheriting the request
 * lifetime. Production callers MUST provide an explicit owner scope; the
 * owner-less form exists only for low-level tests and standalone composition.
 */
export function* startOwnedTask<T = void>(
  operation: () => Operation<T>,
  options: OwnedTaskOptions<T> = {},
): Operation<OwnedTaskHandle<T>> {
  let resolveDone!: (status: OwnedTaskStatus) => void;
  const done = new Promise<OwnedTaskStatus>((resolve) => {
    resolveDone = resolve;
  });
  const state = {
    status: "pending" as OwnedTaskStatus,
    result: undefined as T | undefined,
    error: undefined as Error | undefined,
  };

  const [taskScope, destroyTaskScope] = createScope(options.ownerScope);
  let destroyPromise: Promise<void> | undefined;
  const destroy = (): Promise<void> => {
    destroyPromise ??= destroyTaskScope().then(() => undefined);
    return destroyPromise;
  };

  const handle: OwnedTaskHandle<T> = {
    status: () => state.status,
    result: () => state.result,
    error: () => state.error,
    isDone: () =>
      state.status === "complete" || state.status === "error" || state.status === "halted",
    *waitForDone() {
      if (!handle.isDone()) {
        yield* call(() => done);
      }
      return state.status;
    },
    *halt() {
      if (state.status === "pending" || state.status === "running") {
        state.status = "halted";
        resolveDone("halted");
        yield* call(destroy);
      }
    },
  };

  state.status = "running";
  const running = taskScope.run(function* () {
    try {
      state.result = yield* operation();
      if (state.status === "running") {
        state.status = "complete";
        resolveDone("complete");
      }
    } catch (error) {
      if (state.status === "halted") {
        return;
      }
      state.error = error instanceof Error ? error : new Error(String(error));
      state.status = "error";
      resolveDone("error");
    }
  });
  running.then(destroy, destroy).catch(() => undefined);

  options.register?.(handle);
  return handle;
}
