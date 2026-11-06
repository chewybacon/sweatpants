import type { SchemeMachine } from "@sweatpan.ts/codemode-runtime-scheme";
/** Transitional fixture compiles the real v1 tool and uses the v2-owned Hoot loader.
 * Legacy compiler internals remain outside v2's declaration compilation. */
export const source: string;
export const identity: string;
export const program: string;
export function machineLoader(): Promise<SchemeMachine>;
