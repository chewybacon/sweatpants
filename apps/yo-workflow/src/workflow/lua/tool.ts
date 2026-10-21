import { createDurableTool } from "@sweatpants/agent-sdk";
import { assertJson, canonicalJson, sha256, type Json } from "@sweatpants/foundation";
import { validateAuthoredSchema } from "@sweatpants/foundation/parser";
import { decisionRequestSchema } from "@sweatpants/model-decision";
import { call, type Operation } from "effection";
import { z } from "zod";
import type { BoundTool } from "../bound-tool.ts";
import { decisionBinding, decisionContract } from "../decisions.ts";
import { randomValue, randomParameters, randomContract } from "../random.ts";
import {
  sampleCompletion,
  samplingParameters,
  samplingContract,
  samplingIdentity,
} from "../sampling.ts";
import { resolveLuaFuelPolicy, type LuaFuelPolicy } from "./fuel.ts";
import { encodeLuaCheckpoint, decodeLuaCheckpoint } from "./checkpoint.ts";
import { computationApproval } from "../tools/computation-approval.ts";
import { LuaEvaluationPort } from "./evaluation.ts";

export function createLuaTool(
  bindings: readonly BoundTool[],
  options: Partial<LuaFuelPolicy> = {},
) {
  const fuelPolicy = resolveLuaFuelPolicy(options);
  const registry = new Map(bindings.map((tool) => [tool.name, tool]));
  const contracts = [
    ...bindings.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.artifacts.parameters.inputProjection,
      output: tool.artifacts.output?.outputProjection ?? null,
    })),
    randomContract,
    samplingContract,
    decisionContract,
  ];
  const names = contracts.map((contract) => contract.name);
  if (registry.size !== bindings.length || new Set(names).size !== names.length) {
    throw new Error("Duplicate Lua capability");
  }
  const prelude = names
    .map(
      (name) =>
        `local function ${name}(request) return workflow.effect("${name}", { name = "${name}", input = request }) end`,
    )
    .join("\n");
  return createDurableTool("lua")
    .description(`Author and execute an ordinary Lua workflow in Piccolo/Wasm. Supply title, program, optional JSON input and validateOnly. Validate before executing. Return a single JSON-compatible value.
Use local variables, functions, recursion, loops, tables, if/elseif/else, arithmetic and concatenation (..). The input global contains the supplied JSON input. Standard library is limited to assert, type, pcall, error: no math, string, table, tostring, tonumber, print, IO, require, coroutine, clock, timers or concurrent tasks. Use explicit comparisons and loops. JSON null is workflow.null; empty arrays use workflow.array({}). Nonempty sequential tables become arrays; string-keyed tables become objects. Never use nil for a JSON null.
Call capabilities by name with a single request table: ask({message="Question", suggestions={"A","B"}}), random({choices={"A","B"}}), etc. ask returns action (accept/decline/cancel); accepted content.reply is the human's literal text. Handle each action. Requests park the workflow; the same program resumes with the recorded result. A loop may span many human turns. Keep scores, history and corrections in ordinary Lua values. Random results are journaled. Do not implement or redefine capabilities, call workflow.effect directly, or invent API fields. No child workflow invocation is implemented for Lua.
Capability contracts (JSON schemas describe Lua table shapes):\n${JSON.stringify(contracts)}`)
    .identity({
      version: "0.0.1",
      digest: sha256(
        canonicalJson({
          engine: "piccolo-chat-2",
          fuelPolicy,
          computationApproval: computationApproval.manifest.digest,
          prelude,
          samplingIdentity,
          decisionBinding,
          bindings: bindings.map((tool) => ({
            name: tool.name,
            digest: tool.manifest.digest,
            interface: tool.interfaceDigest,
          })),
        }),
      ),
    })
    .parameters(
      z
        .object({
          title: z.string().min(1).max(120).optional(),
          program: z.string().min(1).max(48000),
          input: z.json().optional(),
          validateOnly: z.boolean().optional(),
        })
        .strict(),
    )
    .output(z.json())
    .samples()
    .decisions(decisionBinding)
    .execute(function* ({ program, input, validateOnly }, context): Operation<Json> {
      if (!(yield* LuaEvaluationPort.isInstalled())) {
        throw new Error("Lua evaluation driver is not installed");
      }
      const source = `${prelude}\n${program}`;
      try {
        yield* LuaEvaluationPort.api.operations.execute({ action: "validate", source });
      } catch (error) {
        // Model-visible diagnostics are also asserted by the Lua tool tests.
        return { status: "invalid", diagnostic: { message: String(error) }, completedEffects: 0 };
      }
      if (validateOnly) {
        return {
          status: "valid",
          checks: { checked: ["syntax"], unchecked: ["runtime", "capability requests"] },
        };
      }
      let slice = 0;
      let allowance = Math.min(fuelPolicy.allowanceFuel, fuelPolicy.maxFuel);
      let cancelled = false;
      let cancellationFuel = 0;
      function* evaluate(command: Json): Operation<Record<string, Json>> {
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
            request: z
              .object({ request: z.object({ name: z.string(), input: z.json() }) })
              .optional(),
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
            const callId = `${invocationId}/fuel-${allowance}`;
            yield* context.emit("tool_started", {
              callId,
              tool: "computation_approval",
              input: {},
            });
            const result = yield* context.pull({
              kind: "invoke",
              child: {
                id: computationApproval.manifest.programId,
                version: computationApproval.manifest.version,
                digest: computationApproval.manifest.digest,
                input: {},
              },
            });
            yield* context.emit("tool_completed", {
              callId,
              tool: "computation_approval",
              result,
              failed: false,
            });
            answer = z.object({ action: z.string() }).parse(result).action === "accept";
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
        const { name, input: data } = boundary.request.request;
        const binding = registry.get(name);
        const schema =
          binding?.parameters ??
          (name === "random"
            ? randomParameters
            : name === "sample"
              ? samplingParameters
              : name === "decision"
                ? decisionRequestSchema
                : undefined);
        if (!schema) {
          return {
            status: "failed",
            diagnostic: { message: `Unknown Lua capability: ${name}` },
            completedEffects: count,
          };
        }
        const checked = validateAuthoredSchema<Json>(schema, data);
        if (checked.status !== "ok") {
          return {
            status: "failed",
            diagnostic: { message: `Invalid ${name} request: ${JSON.stringify(checked)}` },
            completedEffects: count,
          };
        }
        const callId = `${invocationId}/tool-${count}`;
        yield* context.emit("tool_started", {
          callId,
          tool: name,
          input: assertJson(checked.value),
        });
        let value: Json;
        if (binding) {
          value = assertJson(
            yield* context.pull({
              kind: "invoke",
              child: {
                id: binding.manifest.programId,
                version: binding.manifest.version,
                digest: binding.manifest.digest,
                input: assertJson(checked.value),
              },
            }),
          );
        } else if (name === "random") {
          value = yield* randomValue(randomParameters.parse(checked.value), context);
        } else if (name === "decision") {
          value = assertJson(yield* context.decision(decisionRequestSchema.parse(checked.value)));
        } else {
          value = assertJson(
            yield* sampleCompletion(samplingParameters.parse(checked.value), context, callId),
          );
        }
        count++;
        yield* context.emit("tool_completed", { callId, tool: name, result: value, failed: false });
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
    });
}
