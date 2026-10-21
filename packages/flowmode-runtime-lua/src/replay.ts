import { call, type Operation } from "effection";
import { assertJson, type Json } from "@sweatpants/foundation";
import type { DurableProgramContext } from "@sweatpants/durable-execution";
import { z } from "zod";
import { LuaEvaluationPort, type LuaCommand } from "./evaluation.ts";
import { encodeLuaCheckpoint, decodeLuaCheckpoint } from "./checkpoint.ts";
import { resolveLuaFuelPolicy, type LuaFuelPolicy } from "./fuel.ts";

export interface LuaReplayOptions {
  source: string;
  input?: Json;
  fuelPolicy: LuaFuelPolicy;
  context: Pick<DurableProgramContext, "record">;
  approveComputation(callId: string): Operation<boolean>;
  executeCapability(
    request: { name: string; input: Json },
    count: number,
    invocationId: string,
  ): Operation<{ ok: true; value: Json } | { ok: false; result: Json }>;
}

/** Journaled compute slices support durable-tool replay, not authority continuation checkpoints.
 * Capability policy, prompts and UI events belong to the consuming tool.
 */
export function* runLuaReplay(options: LuaReplayOptions): Operation<Json> {
  const { source, input, context } = options;
  const fuelPolicy = resolveLuaFuelPolicy(options.fuelPolicy);
  let slice = 0;
  let allowance = Math.min(fuelPolicy.allowanceFuel, fuelPolicy.maxFuel);
  let cancelled = false;
  let cancellationFuel = 0;
  function* evaluate(command: LuaCommand): Operation<Record<string, Json>> {
    const encoded = yield* context.record(
      { key: `lua.compute/${slice++}`, retrySafety: { mode: "repeatable" } },
      function* () {
        try {
          const result = yield* LuaEvaluationPort.api.operations.execute(command);
          return yield* call(() => encodeLuaCheckpoint(result));
        } catch (error) {
          // Persist the actual evaluator diagnostic so the model can repair the program.
          const failed = {
            boundary: {
              kind: "failed",
              error: { code: "lua_execution_error", message: String(error) },
            },
          };
          return yield* call(() => encodeLuaCheckpoint(failed));
        }
      },
    );
    return yield* call(() => decodeLuaCheckpoint(encoded));
  }
  let state = yield* evaluate({
    action: "start",
    source,
    input: input ?? null,
    fuel: Math.min(fuelPolicy.sliceFuel, allowance),
  });
  let count = 0;
  const invocationId = yield* context.record(
    { key: "lua.invocation-id", retrySafety: { mode: "repeatable" } },
    function* (attempt) {
      return attempt.pullId;
    },
  );
  while (true) {
    const boundary = z
      .object({
        kind: z.string(),
        value: z.json().optional(),
        error: z.json().optional(),
        request: z.object({ request: z.object({ name: z.string(), input: z.json() }) }).optional(),
      })
      .parse(state.boundary);
    if (boundary.kind === "cancelled") {
      return { status: "cancelled", completedEffects: count };
    }
    if (boundary.kind === "completed") {
      return assertJson(boundary.value);
    }
    if (boundary.kind === "failed") {
      return {
        status: "failed",
        diagnostic: { message: JSON.stringify(boundary.error) },
        completedEffects: count,
      };
    }
    const used = typeof state.fuel_used === "number" ? state.fuel_used : 0;
    if (cancelled && used - cancellationFuel >= 100_000) {
      return {
        status: "cancelled",
        diagnostic: {
          code: "cleanup_budget_exceeded",
          message: "Cancellation cleanup exceeded its computation allowance",
        },
        completedEffects: count,
      };
    }
    if (!cancelled && used >= fuelPolicy.maxFuel) {
      return {
        status: "failed",
        diagnostic: {
          code: "execution_budget_exceeded",
          message: "Workflow reached the maximum computation allowance",
        },
        completedEffects: count,
      };
    }
    if (!cancelled && used >= allowance) {
      let answer = fuelPolicy.onExhausted === "continue";
      if (fuelPolicy.onExhausted === "ask") {
        answer = yield* options.approveComputation(`${invocationId}/fuel-${allowance}`);
      }
      if (!answer) {
        cancelled = true;
        cancellationFuel = used;
        state = yield* evaluate({
          action: "cancel",
          source,
          state,
          reason: "Computation declined",
          fuel: fuelPolicy.sliceFuel,
        });
        continue;
      }
      allowance = Math.min(allowance + fuelPolicy.allowanceFuel, fuelPolicy.maxFuel);
    }
    if (boundary.kind === "compute_paused") {
      state = yield* evaluate({
        action: "continue",
        source,
        state,
        fuel: Math.max(
          1,
          Math.min(
            fuelPolicy.sliceFuel,
            cancelled ? 100_000 - (used - cancellationFuel) : allowance - used,
          ),
        ),
      });
      continue;
    }
    if (boundary.kind !== "suspended" || !boundary.request) {
      throw new Error("Unexpected Lua boundary");
    }
    const effect = yield* options.executeCapability(boundary.request.request, count, invocationId);
    if (!effect.ok) {
      return effect.result;
    }
    const value = effect.value;
    count++;
    state = yield* evaluate({
      action: "resume",
      fuel: Math.max(
        1,
        Math.min(
          fuelPolicy.sliceFuel,
          cancelled ? 100_000 - (used - cancellationFuel) : allowance - used,
        ),
      ),
      source,
      state,
      reply: value,
    });
  }
}
