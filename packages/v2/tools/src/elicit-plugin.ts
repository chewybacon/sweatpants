import { assertUniqueElicitIds } from "./elicit-support.ts";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { EffectDefinition } from "@sweatpan.ts/core";
import type { ClientElicitHandlers, ElicitPluginBuilder } from "./contracts.ts";
import type { ToolDefinition } from "./contracts.ts";
import { projectToolContract } from "./contract.ts";

/** Declare a frontend's capability vocabulary without binding runtime instances. */
export function defineElicitPlugins<Capabilities extends object = Record<never, never>>() {
  return function defineElicitPlugin<
    S extends StandardSchemaV1,
    D extends Record<string, EffectDefinition>,
    L extends Record<string, EffectDefinition>,
    Result,
  >(definition: ToolDefinition<S, D, L, Result>): ElicitPluginBuilder<L, Capabilities> {
    assertUniqueElicitIds(definition.elicits);
    const contract = projectToolContract(definition);
    return Object.freeze({
      onElicit<Y = never>(handlers: ClientElicitHandlers<L, Capabilities, Y>) {
        const registered = Object.freeze({ ...handlers });
        const keys = Object.freeze(Object.keys(registered));
        for (const key of keys) {
          if (!Object.hasOwn(contract.elicits, key) || typeof registered[key] !== "function") {
            throw new Error(`Unknown elicit handler: ${key}`);
          }
        }
        return Object.freeze({
          contract,
          support: Object.freeze({ tool: contract.id, elicits: keys }),
          handlers: registered,
        });
      },
    });
  };
}

/** Default headless declarations have no additional frontend capabilities. */
export const defineElicitPlugin = defineElicitPlugins();
