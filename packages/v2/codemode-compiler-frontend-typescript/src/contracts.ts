import type { WorkflowFrontend } from "@sweatpan.ts/codemode-compiler";
import type { CodeSource } from "@sweatpan.ts/codemode-runtime";
import type { EffectDefinition } from "@sweatpan.ts/core";

/** Explicit source graph and assembly-selected declarations; no implicit host imports. */
export interface TypeScriptWorkflowInput {
  readonly source: CodeSource & { readonly language: "typescript"; readonly id: string };
  /** Source IDs and text, resolved by the frontend's supported module policy. */
  readonly modules: Readonly<Record<string, string>>;
  readonly effects: Readonly<Record<string, Pick<EffectDefinition, "id" | "context" | "response">>>;
}

/** ScriptC is a possible implementation, not part of the public boundary. */
export type TypeScriptWorkflowFrontend<Y> = WorkflowFrontend<TypeScriptWorkflowInput, Y>;
