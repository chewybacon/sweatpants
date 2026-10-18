import type { AnyToolContract } from "@sweatpants/agent-sdk";
import { exactProgramKey } from "@sweatpants/durable-execution";
import type { DurableTool } from "@sweatpants/durable-execution";
import { durableEffectKey } from "@sweatpants/durable-effects";
import type { DurableSchemaRegistry } from "@sweatpants/journal-authority/schema-registry";

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
    if (
      !readiness.programs.has(
        exactProgramKey({
          id: manifest.programId,
          version: manifest.version,
          digest: manifest.digest,
        }),
      )
    ) {
      return false;
    }
    for (const effect of Object.values(manifest.effects)) {
      if (!readiness.effects.has(durableEffectKey(effect.name, effect.version))) {
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
