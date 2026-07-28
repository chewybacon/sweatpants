import type { AnyToolContract } from "@sweatpants/core";
import type { DurableSchemaRegistry, DurableTool } from "@sweatpants/session-contract";
import { toToolParameterJsonSchema } from "./tool-parameters.ts";
import type { ToolInventoryEntry } from "@sweatpants/chat-core";

export {
  ToolExposureApi,
  ToolExposurePolicyContext,
  ToolInventoryApi,
  ToolInventoryContext,
  ToolInventoryError,
  ToolExposureError,
  createToolInventory,
  defaultToolExposurePolicy,
} from "@sweatpants/chat-core";
export type {
  SamplingToolDefinitionLike,
  ToolCapabilities,
  ToolDefinition,
  ToolExposurePhase,
  ToolExposurePolicy,
  ToolInventory,
  ToolInventoryEntry,
} from "@sweatpants/chat-core";

/** Deployment-scoped exact placement readiness used before model exposure. */
export interface ToolPlacementReadiness {
  /** Ordinary public names with an installed executable runtime. */
  ordinaryTools: ReadonlySet<string>;
  /** Installed compatible ProgramDriver kinds. */
  drivers: ReadonlySet<string>;
  /** Exact pinned program bundle keys (`id@version#digest`). */
  programs: ReadonlySet<string>;
  /** Registered exact effect keys (`name@version`). */
  effects: ReadonlySet<string>;
  /** Retained current + historical schema validator registry. */
  schemas: DurableSchemaRegistry;
  /** Public durable name → selected driver kind. */
  durableDrivers: ReadonlyMap<string, string>;
}

/**
 * Intersects generated contracts with complete deployment placement. Durable
 * contracts disappear unless the exact program, compatible driver, every
 * effect, and every reachable schema validator are installed. No ordinary
 * fallback is considered under the same public name.
 */
export function projectAvailableToolContracts(
  contracts: readonly AnyToolContract[],
  readiness: ToolPlacementReadiness,
): AnyToolContract[] {
  return contracts.filter((contract) => {
    if (contract.execution !== "crank_native") {
      return readiness.ordinaryTools.has(contract.name);
    }
    const durable = contract as AnyToolContract & DurableTool<any, any>;
    const manifest = durable.manifest;
    if (!manifest) {
      return false;
    }
    const driver = readiness.durableDrivers.get(contract.name);
    if (!driver || !readiness.drivers.has(driver)) {
      return false;
    }
    if (!readiness.programs.has(`${manifest.programId}@${manifest.version}#${manifest.digest}`)) {
      return false;
    }
    for (const effect of Object.values(manifest.effects)) {
      if (!readiness.effects.has(`${effect.name}@${effect.version}`)) {
        return false;
      }
    }
    const requiredDigests = [
      manifest.inputSchema.digest,
      manifest.outputSchema.digest,
      ...Object.values(manifest.elicits).flatMap((elicit) => [
        elicit.response.digest,
        ...(elicit.context ? [elicit.context.digest] : []),
      ]),
      ...Object.values(manifest.effects).flatMap((effect) => [
        effect.inputSchema.digest,
        effect.outputSchema.digest,
        ...(effect.cancellation ? [effect.cancellation.partialSchema.digest] : []),
      ]),
    ];
    return readiness.schemas.missing(requiredDigests).length === 0;
  });
}

/**
 * Project any execution-neutral tool contract into a model-safe inventory
 * entry. The contract's retained portable parameter projection is consumed
 * directly; the runtime schema is never re-lowered here, and no callable
 * execution surface is required.
 */

export function createToolInventoryEntry(
  tool: AnyToolContract,
  metadata?: Record<string, unknown>,
): ToolInventoryEntry {
  const projection = tool.artifacts?.parameters?.inputProjection;
  let parameters: Record<string, unknown>;
  if (
    projection !== undefined &&
    projection !== null &&
    typeof projection === "object" &&
    !Array.isArray(projection)
  ) {
    // Model-facing definitions omit descriptor-internal identifiers.
    const { $id: _id, $schema: _schema, ...rest } = projection as Record<string, unknown>;
    parameters = rest;
  } else {
    // Legacy runtime tools without artifacts fall back to one-time lowering.
    parameters = toToolParameterJsonSchema(tool.parameters);
  }
  return {
    definition: {
      name: tool.name,
      description: tool.description,
      parameters,
    },
    capabilities: {
      elicits: Boolean(tool.capabilities?.elicitation),
      samples: Boolean(tool.capabilities?.sampling),
    },
    ...(metadata ? { metadata } : {}),
  };
}
