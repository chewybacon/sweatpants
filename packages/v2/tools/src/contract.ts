import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { EffectDefinition } from "@sweatpan.ts/core";
import type { ToolContract, ToolDefinition } from "./contracts.ts";

/**
 * Project a tool's typed public interface without acquiring or executing it.
 * Whitelist fields at runtime, including nested capability and elicitation surfaces.
 * Returned objects/maps are shallow-frozen; schemas and call builders retain identity.
 * Use original declarations for server grant/handler registration: projected objects
 * are distinct identities and cannot replace originals in an existing registry.
 * Importing the source definition still imports its module and dependencies; this
 * helper provides no browser bundling, JSON schema export, or security sandbox.
 */
export function projectToolContract<
  S extends StandardSchemaV1,
  D extends Record<string, EffectDefinition>,
  L extends Record<string, EffectDefinition>,
  R,
>(tool: ToolDefinition<S, D, L, R>): ToolContract<S, D, L, R> {
  return Object.freeze({
    ...projectEffect(tool),
    capabilities: projectDefinitions(tool.capabilities),
    elicits: projectDefinitions(tool.elicits),
  });
}

function projectEffect<E extends EffectDefinition>(effect: E): Pick<E, keyof EffectDefinition> {
  return Object.freeze({
    id: effect.id,
    context: effect.context,
    response: effect.response,
    call: effect.call,
  });
}

function projectDefinitions<D extends Record<string, EffectDefinition>>(
  definitions: D,
): { readonly [K in keyof D]: Pick<D[K], keyof EffectDefinition> } {
  // Object.entries erases the alias/value correlation only during map construction.
  // Each alias is retained with the exact declaration's whitelisted surface.
  return Object.freeze(
    Object.fromEntries(
      Object.entries(definitions).map(([alias, definition]) => [alias, projectEffect(definition)]),
    ),
  ) as { readonly [K in keyof D]: Pick<D[K], keyof EffectDefinition> };
}
