import { createContext, type Operation } from "effection";
import type {
  DurableEffectRegistration,
  DurableTool,
  ProgramDriver,
  ProgramRoute,
} from "@sweatpants/session-contract";

export type NativeProgramIdentity = { id: string; version: string; digest: string };

/** One public model-tool name routed to a crank-native child program. */
export interface ProgramDriverNativeToolBinding {
  readonly publicName: string;
  readonly tool: DurableTool<any, any>;
  readonly route: ProgramRoute;
}

/** Deployment composition for location-transparent native durable tools. */
export interface ProgramDriverNativeToolComposition {
  readonly bindings: ReadonlyMap<string, ProgramDriverNativeToolBinding>;
  readonly drivers: readonly (readonly [string, ProgramDriver])[];
  readonly effects: readonly DurableEffectRegistration[];
}

/** Scoped native durable-tool inventory supplied by application setup. */
export const ProgramDriverNativeToolsContext = createContext<
  ProgramDriverNativeToolComposition | undefined
>("ProgramDriverNativeTools", undefined);

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
