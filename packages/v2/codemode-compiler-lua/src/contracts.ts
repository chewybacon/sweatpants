import type { WorkflowModule } from "@sweatpan.ts/codemode-compiler";
/** Lua-kernel input; machine acquisition and effect grants remain assembly-owned. */
export interface LuaWorkflowArtifact {
  readonly format: "lua-execution/1";
  readonly source: string;
  readonly effects: WorkflowModule["effects"];
}
