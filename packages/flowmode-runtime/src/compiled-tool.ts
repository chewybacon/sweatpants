import type { Json } from "@sweatpants/foundation";
import type { DurableTool } from "@sweatpants/durable-execution";
import type { CompiledWorkflow } from "./authoring.ts";

const compiledTools = new WeakMap<object, Readonly<Record<string, CompiledWorkflow>>>();

/** Build integration attaches portable data without changing the ordinary SDK tool. */
export function registerCompiledWorkflows<T extends object>(
  tool: T,
  artifacts: Readonly<Record<string, CompiledWorkflow>>,
): void {
  if (compiledTools.has(tool)) {
    throw new Error("Workflow tool already has compiled artifacts");
  }
  compiledTools.set(tool, artifacts);
}

/** Framework registration selects the same language as the authored caller. */
export function getCompiledWorkflow<I extends Json, O extends Json>(
  tool: DurableTool<I, O>,
  language: string,
): CompiledWorkflow<I, O> {
  const artifact = compiledTools.get(tool)?.[language];
  if (!artifact) {
    throw new Error(`No compiled ${language} workflow; enable workflowPlugin in Vite`);
  }
  return artifact as CompiledWorkflow<I, O>;
}
