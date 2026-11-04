import type { OperationMiddleware } from "@standard-durability/core";
import type { CheckpointAdapter, Execution } from "@sweatpan.ts/execution";
import type { Checkpoint, RecoveryMethods } from "./contracts.ts";
import { validate, replay } from "./recovery-history.ts";

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
