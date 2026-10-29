import { call, type Operation } from "effection";
import { assertJson, type Json, type Exchange } from "@sweatpants/foundation";
import type { DurableProgramContext } from "@sweatpants/durable-execution";
import {
  MontyEvaluationPort,
  type MontyCommand,
} from "@sweatpants/flowmode-runtime-monty/evaluation";
import {
  encodeMontyCheckpoint,
  decodeMontyCheckpoint,
} from "@sweatpants/flowmode-runtime-monty/checkpoint";
import { z } from "zod";

type CapabilityReply = { kind: "resume"; value: Json } | { kind: "stop"; result: Json };
export interface PythonReplayOptions {
  source: string;
  validateOnly: boolean;
  context: Pick<DurableProgramContext, "record">;
  exchange: Exchange<
    { capability: { name: string; input: Json }; completedEffects: number; invocationId: string },
    CapabilityReply
  >;
}
const boundarySchema = z.object({
  kind: z.string(),
  value: z.json().optional(),
  error: z.string().optional(),
  request: z
    .object({
      input: z.object({
        operations: z
          .array(
            z.object({
              id: z.number(),
              request: z.object({ capability: z.string(), arguments: z.json() }),
            }),
          )
          .min(1),
      }),
    })
    .optional(),
});
export function* runPythonReplay(options: PythonReplayOptions): Operation<Json> {
  let slice = 0;
  let completedEffects = 0;
  function* evaluate(command: MontyCommand): Operation<Record<string, Json>> {
    const encoded = yield* options.context.record(
      { key: `python.compute/${slice++}`, retrySafety: { mode: "repeatable" } },
      function* () {
        let result;
        try {
          result = yield* MontyEvaluationPort.api.operations.execute(command);
        } catch (error) {
          result = { boundary: { kind: "failed", error: String(error) } };
        }
        return yield* call(() => encodeMontyCheckpoint(result));
      },
    );
    return yield* call(() => decodeMontyCheckpoint(encoded));
  }
  let state = yield* evaluate({ action: "start", source: options.source });
  const invocationId = yield* options.context.record(
    { key: "python.invocation-id", retrySafety: { mode: "repeatable" } },
    function* (attempt) {
      return attempt.pullId;
    },
  );
  while (true) {
    const boundary = boundarySchema.parse(state.boundary);
    if (boundary.kind === "failed") {
      return {
        status: options.validateOnly ? "invalid" : "failed",
        diagnostic: { message: boundary.error ?? "Python failed" },
        completedEffects,
      };
    }
    if (options.validateOnly) {
      return {
        status: "valid",
        checks: {
          checked: ["execution through first host boundary"],
          unchecked: ["later paths", "capability schemas", "host effects"],
        },
      };
    }
    if (boundary.kind === "completed") {
      return assertJson(boundary.value);
    }
    if (boundary.kind === "cancelled") {
      return { status: "cancelled", completedEffects };
    }
    if (boundary.kind !== "suspended" || !boundary.request || !state.snapshot) {
      throw Error("Unexpected Python boundary");
    }
    const op = boundary.request.input.operations[0];
    const effect = yield* options.exchange({
      capability: {
        name: op.request.capability.replace(/^sandbox\./, ""),
        input: op.request.arguments,
      },
      completedEffects,
      invocationId,
    });
    if (effect.kind === "stop") {
      return effect.result;
    }
    completedEffects++;
    state = yield* evaluate({
      action: "resume",
      source: options.source,
      snapshot: state.snapshot,
      reply: { operationId: op.id, value: effect.value },
    });
  }
}
