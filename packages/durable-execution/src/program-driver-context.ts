import { createContext } from "effection";
import type { DurableTool } from "./program-authoring.ts";
import type { ProgramDriver } from "./program-driver-contract.ts";

export type DurableToolRegistry = ReadonlyMap<string, DurableTool>;
export type ProgramDriverRegistry = ReadonlyMap<string, ProgramDriver>;

/** Deployment-selected driver registry inherited by middleware-capable ProgramPeer calls. */
export const ProgramDriverRegistryContext = createContext<ProgramDriverRegistry | undefined>(
  "durable-execution:program-driver-registry",
  undefined,
);

/** Builds an immutable-by-contract driver lookup and rejects no route policy implicitly. */
export function createProgramDriverRegistry(
  drivers: Iterable<readonly [string, ProgramDriver]>,
): ProgramDriverRegistry {
  return new Map(drivers);
}
