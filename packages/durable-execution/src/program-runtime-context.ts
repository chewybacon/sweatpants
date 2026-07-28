import { createContext, type Operation, type Scope } from "effection";
import type { DurableEffectRegistry } from "@sweatpants/durable-effects";
import { CrankError } from "./errors.ts";
import type { DurableTool } from "./program-authoring.ts";
import type { ProgramDriver } from "./program-driver-contract.ts";

export type DurableToolRegistry = ReadonlyMap<string, DurableTool<any, any>>;
export type ProgramDriverRegistry = ReadonlyMap<string, ProgramDriver>;

export const DurableToolRegistryContext = createContext<DurableToolRegistry | undefined>(
  "durable-execution:durable-tool-registry",
  undefined,
);
export const ProgramDriverRegistryContext = createContext<ProgramDriverRegistry | undefined>(
  "durable-execution:program-driver-registry",
  undefined,
);
export const ExecutionDurableEffectRegistryContext = createContext<
  DurableEffectRegistry | undefined
>("durable-execution:execution-effects", undefined);
export const ProgramExecutionScopeContext = createContext<Scope | undefined>(
  "durable-execution:program-execution-scope",
  undefined,
);

export function createProgramDriverRegistry(
  drivers: Iterable<readonly [string, ProgramDriver]>,
): ProgramDriverRegistry {
  return new Map(drivers);
}

export function* useDurableToolRegistry(): Operation<DurableToolRegistry> {
  const registry = yield* DurableToolRegistryContext.get();
  if (!registry) {
    throw new CrankError("unknown_target", "No durable tool registry is installed");
  }
  return registry;
}

export function* useProgramDriverRegistry(): Operation<ProgramDriverRegistry> {
  const registry = yield* ProgramDriverRegistryContext.get();
  if (!registry) {
    throw new CrankError("unknown_target", "No program driver registry is installed");
  }
  return registry;
}
