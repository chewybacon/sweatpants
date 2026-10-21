import type { SchemeProgram } from "./scheme-ir.js";
import type { CompileRequest } from "@sweatpants/flowmode-runtime";

/** Static declarations extracted from an ordinary SDK tool module. */
export type WorkflowToolDeclaration = Omit<CompileRequest, "source"> & { exportName: string };
export type WorkflowEntry = { name: string; entry: string };
export type WorkflowSite = {
  sourceId?: string;
  function: string;
  line: number;
  column: number;
} & (
  | { operation: "elicit"; key?: string }
  | { operation: "effect"; name: string; version: string }
  | { operation: "scoped" }
);
/** Mutable emission metadata, before publication as portable WorkflowDebugInfo. */
export type EmittedWorkflowDebug = {
  sites: Record<string, WorkflowSite>;
  locations: Record<string, { sourceId?: string; line: number; column: number }>;
};
export type WorkflowEmission = { payload: string; debug: EmittedWorkflowDebug };
/** Target-local emission; the runtime's WorkflowCompiler owns the portable protocol. */
export interface TypeScriptWorkflowTarget {
  definitionFormat: string;
  emit(program: SchemeProgram, definitions: WorkflowEntry[]): WorkflowEmission;
}
