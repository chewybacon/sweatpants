import { CrankError } from "@sweatpants/durable-execution";
import { type SandboxActivationFence } from "@sweatpants/session-contract";
import type { Operation } from "effection";
import { createApi } from "effection/experimental";

export type WorkspaceFence = SandboxActivationFence;

export interface WorkspaceOperationExecution {
  readonly fence: WorkspaceFence;
  readonly operationId: string;
}

export interface WorkspaceObservation {
  readonly workspaceRevision: string;
}

export interface WorkspaceOperations {
  inspect(execution: WorkspaceOperationExecution): Operation<WorkspaceObservation>;
  readFile(
    input: { readonly path: string; readonly startLine?: number; readonly endLine?: number },
    execution: WorkspaceOperationExecution,
  ): Operation<{
    readonly path: string;
    readonly contents: string;
    readonly startLine: number;
    readonly endLine: number;
    readonly workspaceRevision: string;
  }>;
  list(
    input: { readonly path: string },
    execution: WorkspaceOperationExecution,
  ): Operation<{
    readonly path: string;
    readonly entries: string[];
    readonly workspaceRevision: string;
  }>;
  writeFile(
    input: {
      readonly path: string;
      readonly contents: string;
      readonly expectedWorkspaceRevision: string;
    },
    execution: WorkspaceOperationExecution,
  ): Operation<{
    readonly path: string;
    readonly bytes: number;
    readonly workspaceRevision: string;
  }>;
  runScript(
    input: { readonly script: string; readonly expectedWorkspaceRevision: string },
    execution: WorkspaceOperationExecution,
  ): Operation<{
    readonly script: string;
    readonly exitCode: number;
    readonly stdout: string;
    readonly stderr: string;
    readonly workspaceRevision: string;
  }>;
}

export interface WorkspaceFilesApi {
  inspect(): Operation<WorkspaceObservation>;
  readFile(input: {
    readonly path: string;
    readonly startLine?: number;
    readonly endLine?: number;
  }): ReturnType<WorkspaceOperations["readFile"]>;
  list(input: { readonly path: string }): ReturnType<WorkspaceOperations["list"]>;
  writeFile(
    input: {
      readonly path: string;
      readonly contents: string;
      readonly expectedWorkspaceRevision: string;
    },
    execution: { readonly operationId: string },
  ): ReturnType<WorkspaceOperations["writeFile"]>;
  runScript(
    input: { readonly script: string; readonly expectedWorkspaceRevision: string },
    execution: { readonly operationId: string },
  ): ReturnType<WorkspaceOperations["runScript"]>;
}

/** Browser-safe ordinary API contract; providers live in the Node entrypoint. */
export const WorkspaceFiles = createApi<WorkspaceFilesApi>("sweatpants:workspace-files", {
  *inspect() {
    throw new CrankError("workspace_unavailable", "Workspace provider is not installed");
  },
  *readFile() {
    throw new CrankError("workspace_unavailable", "Workspace provider is not installed");
  },
  *list() {
    throw new CrankError("workspace_unavailable", "Workspace provider is not installed");
  },
  *writeFile() {
    throw new CrankError("workspace_unavailable", "Workspace provider is not installed");
  },
  *runScript() {
    throw new CrankError("workspace_unavailable", "Workspace provider is not installed");
  },
});
