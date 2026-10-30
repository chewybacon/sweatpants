import type {
  CheckpointAdapter,
  Guest,
  ProgramExecution,
  ProgramExecutionOptions,
  ProgramExecutionFrom,
  ResolvedProgram,
} from "./contracts.ts";

/**
 * Bind admitted input to fresh acquisition and optional restoration through one resolver.
 * Every acquisition/restore verifies the pinned reference before entering the evaluator.
 * Captures use only the adapter that created that exact Guest. Resolution errors and
 * supported restoration failures propagate; this helper never falls back to acquisition.
 * Guest/resource lifetime remains owned by the caller's surrounding scope.
 */
export function createProgramExecution<I, P extends ResolvedProgram<unknown, unknown, unknown>, Y>(
  options: ProgramExecutionOptions<I, P, Y>,
): ProgramExecutionFrom<P, Y>;
export function createProgramExecution(
  options: ProgramExecutionOptions<unknown, ResolvedProgram<unknown, unknown, unknown>, unknown>,
): ProgramExecution<unknown, unknown, unknown> {
  const invocation = Object.freeze({ ...options.invocation });
  const { resolve, checkpointFormat: format } = options;
  const owned = new WeakMap<
    Guest<unknown, unknown, unknown>,
    CheckpointAdapter<unknown, unknown, unknown, unknown, unknown, unknown>
  >();
  function* select() {
    const selected = yield* resolve(invocation);
    if (selected.program !== invocation.program) {
      throw new Error("Resolved program differs from pinned invocation");
    }
    return selected;
  }
  const checkpoints:
    | CheckpointAdapter<unknown, unknown, unknown, unknown, unknown, unknown>
    | undefined =
    format === undefined
      ? undefined
      : {
          format,
          *capture(guest) {
            const adapter = owned.get(guest);
            return adapter ? yield* adapter.capture(guest) : undefined;
          },
          *restore(state) {
            const selected = yield* select();
            const adapter = selected.checkpoints;
            if (!adapter || adapter.format !== format) {
              throw new Error("Resolved program checkpoint format is unavailable");
            }
            const restored = yield* adapter.restore(state);
            owned.set(restored.guest, adapter);
            return restored;
          },
        };
  return {
    *acquire() {
      const selected = yield* select();
      const guest = yield* selected.acquire();
      if (format !== undefined && selected.checkpoints?.format === format) {
        owned.set(guest, selected.checkpoints);
      }
      return guest;
    },
    checkpoints,
  };
}
