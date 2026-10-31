import type { KernelIdentity, WorkflowKernel } from "@sweatpants/flowmode-runtime";
export type MontyModuleLoader = (name: string) => WebAssembly.Module | Promise<WebAssembly.Module>;
export const montyIdentity: Readonly<KernelIdentity>;
export const playgroundIdentity: Readonly<KernelIdentity>;
export function createMontyKernel(
  loadModule: MontyModuleLoader,
  options?: { profile?: "playground" },
): WorkflowKernel;
