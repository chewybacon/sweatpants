import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { Operation, Outcome } from "@standard-durability/core";
import { defineEffect, type EffectDefinition } from "@sweatpan.ts/core";
import type { ToolBuilder, ToolDefinition } from "./contracts.ts";

/**
 * Declare a callable tool and infer its result from an evaluator-owned body.
 * This creates no runtime or grant. Definitions retain schemas and executable
 * bodies; importing one is not a browser-safe contract splitting mechanism.
 */
export function defineTool(name: string): {
  /** Set the schema converting caller input to the body's normalized input. */
  parameters<S extends StandardSchemaV1>(schema: S): ToolBuilder<S>;
} {
  return Object.freeze({
    parameters<S extends StandardSchemaV1>(schema: S): ToolBuilder<S> {
      return builder(name, schema, Object.freeze({}), Object.freeze({}));
    },
  });
}

function builder<
  S extends StandardSchemaV1,
  D extends Record<string, EffectDefinition>,
  L extends Record<string, EffectDefinition>,
>(name: string, schema: S, capabilities: D, elicits: L): ToolBuilder<S, D, L> {
  return Object.freeze({
    capabilities<const Next extends Record<string, EffectDefinition>>(definitions: Next) {
      return builder(name, schema, Object.freeze({ ...definitions }), elicits);
    },
    elicits<const Next extends Record<string, EffectDefinition>>(definitions: Next) {
      return builder(name, schema, capabilities, Object.freeze({ ...definitions }));
    },
    execute<R>(body: ToolDefinition<S, D, L, R>["body"]): ToolDefinition<S, D, L, R> {
      const effect = defineEffect({ key: name, context: schema }, function* (): Operation<
        Outcome<R, never>,
        never
      > {
        throw new Error("Tool body requires Guest acquisition");
      });
      return Object.freeze({
        id: effect.id,
        context: schema,
        call: effect.call,
        capabilities,
        elicits,
        body,
      });
    },
  });
}
