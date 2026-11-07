import type { WorkflowModule } from "@sweatpan.ts/codemode-compiler";
import type { EffectDefinition } from "@sweatpan.ts/core";
import type { CodeSource } from "@sweatpan.ts/codemode-runtime";

/** Structural view accepted directly from a public ToolDefinition/ToolContract.
 * The trusted build assembly selects declarations; compilation executes no body.
 */
export interface ToolBuildContract {
  readonly id: string;
  readonly context: unknown;
  readonly capabilities: Readonly<
    Record<string, Pick<EffectDefinition, "id" | "context" | "response">>
  >;
  readonly elicits: Readonly<Record<string, Pick<EffectDefinition, "id" | "context" | "response">>>;
}
export interface TypeScriptToolBuildInput {
  readonly source: CodeSource & { readonly language: "typescript"; readonly id: string };
  readonly exportName: string;
  /** Explicit declaration-module source graph, hashed but never evaluated. */
  readonly modules: Readonly<Record<string, string>>;
  readonly tool: ToolBuildContract;
}
export interface WorkflowBuildProvenance {
  readonly compiler: string;
  readonly parser: string;
  readonly implementation: string;
  readonly profile: "tool-string-outcome/1";
  readonly inputs: {
    readonly entry: string;
    readonly exportName: string;
    readonly sources: Readonly<Record<string, string>>;
    readonly declarations: string;
  };
}
export interface WorkflowBuildArtifact {
  readonly format: "typescript-workflow-build/1";
  readonly key: string;
  readonly provenance: WorkflowBuildProvenance;
  readonly module: WorkflowModule;
  /** Detects accidental cache corruption; not a signature or authorization proof. */
  readonly digest: string;
}
export interface WorkflowBuildResult {
  readonly artifact: WorkflowBuildArtifact;
  readonly cache: "hit" | "miss";
}
