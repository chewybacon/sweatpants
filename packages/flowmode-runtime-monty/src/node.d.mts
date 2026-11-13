import type { WorkflowKernel } from "@sweatpants/flowmode-runtime";
export function loadMontyModule(name: string): Promise<WebAssembly.Module>;
export function createNodeMontyKernel(): WorkflowKernel;
