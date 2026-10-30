import type { EffectDefinition } from "@sweatpan.ts/core";
import type { LuaEffectBindings } from "./contracts.ts";

/**
 * Bind Lua effect names to declared effects. Pass decodeRequest to createLuaEvaluator
 * and independently grant the permitted definitions through hosting.
 * The mapping is captured now; changing it changes the program's replay contract.
 * Example: workflow.effect("lookup-site", { effect = "lookup", input = "topic" }).
 * The site is VM metadata; journal position and logical scope identify invocations.
 */
export function defineLuaEffectBindings(
  definitions: Readonly<Record<string, EffectDefinition>>,
): LuaEffectBindings {
  const names = new Map(Object.entries(definitions).map(([name, effect]) => [name, effect.id]));
  return Object.freeze({
    decodeRequest(value: unknown) {
      const envelope = record(value);
      const request = record(envelope.request);
      if (
        typeof envelope.site !== "string" ||
        typeof request.effect !== "string" ||
        !("input" in request)
      ) {
        throw new Error("Malformed Lua effect request");
      }
      const effect = names.get(request.effect);
      if (effect === undefined) {
        throw new Error("Unknown Lua effect binding");
      }
      return { effect, input: request.input };
    },
  });
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Malformed Lua effect request");
  }
  return value as Record<string, unknown>;
}
