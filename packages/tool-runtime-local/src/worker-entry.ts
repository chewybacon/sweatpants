import type { RuntimeTool } from "@sweatpants/core";
import { createWorkerTool } from "./worker-tool-adapter.ts";
import { createWorkerToolRegistry, runWorker } from "./worker-runner.ts";

/**
 * Runs a worker entry from canonical authored tool contracts.
 *
 * Callers should await the returned promise at module scope so initialization
 * and terminal failures propagate through worker module loading consistently.
 * Lower-level registry and runner APIs remain available for custom transports.
 */
export async function runToolWorkerEntry(tools: readonly RuntimeTool[]): Promise<void> {
  const registry = createWorkerToolRegistry(tools.map(createWorkerTool));
  await runWorker(registry);
}
