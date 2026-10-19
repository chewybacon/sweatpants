import type { Json, PortableSchemaDescriptor } from "@sweatpants/foundation";
import type { PinnedProgram } from "@sweatpants/durable-execution/program-contract";
import type { Operation } from "effection";
import type { KernelIdentity, WorkflowKernel } from "./index.ts";

export interface WorkflowImplementation {
  readonly format: string;
  readonly payload: Json;
}
export interface BindingContract {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly inputSchema: PortableSchemaDescriptor;
  readonly outputSchema: PortableSchemaDescriptor;
}
export interface BindingDeclaration {
  readonly kind: "compiled" | "host" | "child";
  readonly contract: BindingContract;
}
export interface WorkflowExport {
  readonly name: string;
  readonly entry: string;
  readonly contract: BindingContract;
}
export interface WorkflowSource {
  readonly id: string;
  readonly language: string;
  readonly text: string;
}
export interface SourcePosition {
  readonly sourceId: string;
  readonly line: number;
  readonly column: number;
}
export interface Diagnostic {
  readonly severity: "error" | "warning";
  readonly code: string;
  readonly message: string;
  readonly position?: SourcePosition;
}
export interface WorkflowDebugInfo {
  readonly sites: Readonly<Record<string, Json>>;
  readonly locations: Readonly<Record<string, Json>>;
}
/** Schemas come from trusted declarations; phantom types never replace runtime validation. */
export interface CompiledWorkflow<Input = unknown, Output = unknown> {
  readonly entry: string;
  readonly implementation: WorkflowImplementation;
  readonly exports: readonly WorkflowExport[];
  readonly imports: readonly BindingDeclaration[];
  readonly source: WorkflowSource;
  readonly debug: WorkflowDebugInfo;
  readonly types?: { input: Input; output: Output };
}
export type WorkflowBinding =
  | {
      readonly kind: "compiled";
      readonly contract: BindingContract;
      readonly module: CompiledWorkflow;
      readonly export: string;
    }
  | {
      readonly kind: "host";
      readonly contract: BindingContract;
      readonly capability: { readonly name: string; readonly version: string };
    }
  | { readonly kind: "child"; readonly contract: BindingContract; readonly program: PinnedProgram };
export interface CompileRequest {
  readonly source: WorkflowSource;
  readonly entry: string;
  readonly exports: readonly WorkflowExport[];
  readonly bindings: readonly BindingDeclaration[];
}
export type CompileResult =
  | {
      readonly ok: true;
      readonly module: CompiledWorkflow;
      readonly diagnostics: readonly Diagnostic[];
    }
  | { readonly ok: false; readonly diagnostics: readonly Diagnostic[] };
export interface WorkflowCompiler {
  readonly sourceLanguage: string;
  readonly definitionFormat: string;
  compile(request: CompileRequest): Operation<CompileResult>;
}
export interface WorkflowLinker {
  readonly definitionFormat: string;
  readonly programFormat: string;
  link(input: {
    readonly caller: CompiledWorkflow;
    readonly bindings: readonly WorkflowBinding[];
  }): Operation<WorkflowImplementation>;
}
export interface WorkflowRuntime {
  readonly kernelIdentity: KernelIdentity;
  createKernel(): Operation<WorkflowKernel>;
}
export interface WorkflowAuthoring {
  readonly sourceLanguage: string;
  describe(input: {
    readonly bindings: readonly BindingDeclaration[];
    readonly inputSchema: PortableSchemaDescriptor;
    readonly outputSchema: PortableSchemaDescriptor;
  }): Operation<string>;
}
export interface WorkflowDefinition {
  readonly contract: BindingContract;
  readonly source: WorkflowSource;
  readonly entry: string;
  readonly dependencies: readonly string[];
}
export interface WorkflowLanguage {
  readonly id: string;
  readonly authoring: WorkflowAuthoring;
  readonly compiler: WorkflowCompiler;
  readonly linker: WorkflowLinker;
  readonly runtime: WorkflowRuntime;
}
