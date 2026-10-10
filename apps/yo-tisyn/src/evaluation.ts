import { resource, type Operation } from "effection";
import { definePort } from "@sweatpants/foundation/port";
import { CrankError } from "@sweatpants/durable-execution";
import type { TisynExpr } from "@tisyn/ir";
import type { Json } from "@sweatpants/foundation";

export const EVALUATION_LIMITS = Object.freeze({ stepMilliseconds: 250, toolCalls: 256 });

export type EvaluationStep =
  | { done: false; value: { id: string; data: Json } }
  | { done: true; value: Json };

/** Handles identify temporary compute, never durable work or journal records.
 * Drivers enforce the compute bound on every advance. Closing is idempotent.
 * Only IR, handles, JSON, and step results cross this boundary, not JS callbacks.
 */
export interface TisynEvaluationDriver {
  open(ir: TisynExpr): Operation<string>;
  advance(handle: string, input?: Json): Operation<EvaluationStep>;
  close(handle: string): Operation<void>;
}

function unavailable(): never {
  throw new CrankError("tisyn_evaluation_unavailable", "No Tisyn evaluation driver is installed");
}

export const TisynEvaluationPort = definePort<TisynEvaluationDriver>("tisyn-evaluation", {
  *open(_ir) {
    return unavailable();
  },
  *advance(_handle, _input) {
    return unavailable();
  },
  *close(_handle) {
    return unavailable();
  },
});

export interface Evaluation {
  next(input?: Json): Operation<EvaluationStep>;
}

/** Scope-owned compute. The shared adapter enforces the tool-call budget before
 * exposing a descriptor. Sweatpants still owns all effects and replay.
 */
export function createEvaluation(ir: TisynExpr): Operation<Evaluation> {
  return resource(function* (provide) {
    const handle = yield* TisynEvaluationPort.api.operations.open(ir);
    let terminal = false;
    let toolCalls = 0;
    try {
      yield* provide({
        *next(input) {
          if (terminal) {
            throw new Error("Tisyn evaluation is closed");
          }
          try {
            const step = yield* TisynEvaluationPort.api.operations.advance(handle, input);
            if (!step.done && ++toolCalls > EVALUATION_LIMITS.toolCalls) {
              throw new Error(`Tisyn program exceeded ${EVALUATION_LIMITS.toolCalls} tool calls`);
            }
            terminal = step.done;
            return step;
          } catch (error) {
            terminal = true;
            throw error;
          }
        },
      });
    } finally {
      terminal = true;
      yield* TisynEvaluationPort.api.operations.close(handle);
    }
  });
}
