import type { WorkflowModule } from "@sweatpan.ts/codemode-compiler";

/** Scheme-kernel input; runtime identity and resource acquisition remain separate. */
export interface SchemeWorkflowArtifact {
  readonly format: "scheme-execution/1";
  readonly source: string;
  readonly effects: WorkflowModule["effects"];
}
