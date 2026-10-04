import type { ToolExecutionBinding } from "@sweatpants/tool-session/execution";
import { createContext, type Operation } from "effection";
import type { DurableEffectRegistration } from "@sweatpants/chat-core";
import type { ProgramDriver } from "@sweatpants/durable-execution";

export type NativeProgramIdentity = { id: string; version: string; digest: string };

/** Deployment composition for location-transparent native durable tools. */
export interface ProgramDriverNativeToolComposition {
  readonly bindings: ReadonlyMap<string, ToolExecutionBinding>;
  readonly drivers: readonly (readonly [string, ProgramDriver])[];
  readonly effects: readonly DurableEffectRegistration[];
  /** Installs ordinary scoped APIs for each local program attachment. */
  readonly setup?: () => Operation<void>;
}

/** Scoped native durable-tool inventory supplied by application setup. */
export const ProgramDriverNativeToolsContext = createContext<
  ProgramDriverNativeToolComposition | undefined
>("ProgramDriverNativeTools", undefined);

/**
 * True when any native binding declares fenced activation. The decision is
 * capability-driven: the framework never infers activation safety from a
 * vendor's driverKind string.
 */
export function requiresFencedActivation(
  composition: ProgramDriverNativeToolComposition | undefined,
): boolean {
  if (!composition) {
    return false;
  }
  return [...composition.bindings.values()].some((binding) => binding.activation === "fenced");
}

/** Resolves optional native durable-tool composition from application setup. */
export function* useOptionalProgramDriverNativeTools(): Operation<
  ProgramDriverNativeToolComposition | undefined
> {
  return yield* ProgramDriverNativeToolsContext.get();
}

/** Canonical root-program identity map persisted with the turn input. */
export function nativeProgramIdentities(
  composition: ProgramDriverNativeToolComposition | undefined,
): Record<string, NativeProgramIdentity> {
  if (!composition) {
    return {};
  }
  return Object.fromEntries(
    [...composition.bindings].map(([publicName, binding]) => [
      publicName,
      {
        id: binding.tool.manifest.programId,
        version: binding.tool.manifest.version,
        digest: binding.tool.manifest.digest,
      },
    ]),
  );
}
