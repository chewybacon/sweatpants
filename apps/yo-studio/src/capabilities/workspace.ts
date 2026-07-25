import { createDurableTool, defineDurableContextExtension } from "@sweatpants/core";
import { WorkspaceFiles } from "@sweatpants/workspace-runtime/api";
import { z } from "zod";

const RelativePath = z
  .string()
  .min(1)
  .max(1_024)
  .refine((value) => !value.startsWith("/") && !value.split(/[\\/]/).includes(".."), {
    message: "path must stay within the workspace",
  });
const WorkspaceRevision = z.string().regex(/^[a-f0-9]{64}$/);

const InspectWorkspaceOutput = z.object({ workspaceRevision: WorkspaceRevision });
const WorkspaceLine = z.number().int().positive().max(10_000_000);
const ReadWorkspaceInput = z.object({
  path: RelativePath,
  startLine: WorkspaceLine.optional(),
  endLine: WorkspaceLine.optional(),
});
const ListWorkspaceInput = z.object({ path: RelativePath });
const ListWorkspaceOutput = z.object({
  path: RelativePath,
  entries: z.array(z.string()).max(10_000),
  workspaceRevision: WorkspaceRevision,
});
const ReadWorkspaceOutput = z.object({
  path: RelativePath,
  contents: z.string().max(1024 * 1024),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  workspaceRevision: WorkspaceRevision,
});
const WriteWorkspaceInput = z.object({
  path: RelativePath,
  contents: z.string().max(1024 * 1024),
  expectedWorkspaceRevision: WorkspaceRevision,
});
const WriteWorkspaceOutput = z.object({
  path: RelativePath,
  bytes: z.number().int().nonnegative(),
  workspaceRevision: WorkspaceRevision,
});
const RunWorkspaceScriptInput = z.object({
  script: z.enum(["test", "typecheck", "lint"]),
  expectedWorkspaceRevision: WorkspaceRevision,
});
const RunWorkspaceScriptOutput = z.object({
  script: z.string(),
  exitCode: z.number().int(),
  stdout: z.string(),
  stderr: z.string(),
  workspaceRevision: WorkspaceRevision,
});

/** Ordinary authored workspace namespace. Providers bind WorkspaceFiles per attachment. */
export const workspace = defineDurableContextExtension({
  name: "yo-studio-workspace",
  api: WorkspaceFiles.operations,
});

export const workspaceInspectTool = createDurableTool("workspace_inspect", { version: "2.0.0" })
  .description("Return the current logical workspace revision")
  .parameters(z.object({}))
  .output(InspectWorkspaceOutput)
  .uses({ workspace })
  .execute(function* (_input, context) {
    return yield* context.workspace.inspect();
  });

export const workspaceReadTool = createDurableTool("workspace_read", { version: "2.0.0" })
  .description("Read a bounded line range from one UTF-8 task-workspace file")
  .parameters(ReadWorkspaceInput)
  .output(ReadWorkspaceOutput)
  .uses({ workspace })
  .execute(function* (input, context) {
    return yield* context.workspace.readFile(input);
  });

export const workspaceListTool = createDurableTool("workspace_list", { version: "2.0.0" })
  .description("List one task-workspace directory")
  .parameters(ListWorkspaceInput)
  .output(ListWorkspaceOutput)
  .uses({ workspace })
  .execute(function* (input, context) {
    return yield* context.workspace.list(input);
  });

export const workspaceWriteTool = createDurableTool("workspace_write", { version: "2.0.0" })
  .description("Replace one UTF-8 file at an expected logical workspace revision")
  .parameters(WriteWorkspaceInput)
  .output(WriteWorkspaceOutput)
  .uses({ workspace })
  .execute(function* (input, context) {
    return yield* context.record(
      {
        label: "workspace-write",
        retrySafety: { mode: "idempotent", mechanism: "pull_id_key" },
      },
      function* ({ pullId }) {
        return yield* context.workspace.writeFile(input, { operationId: pullId });
      },
    );
  });

export const workspaceTestTool = createDurableTool("workspace_test", { version: "2.0.0" })
  .description("Run one deployment-declared validation script at an expected workspace revision")
  .parameters(RunWorkspaceScriptInput)
  .output(RunWorkspaceScriptOutput)
  .uses({ workspace })
  .execute(function* (input, context) {
    return yield* context.record(
      {
        label: "workspace-run-script",
        retrySafety: { mode: "idempotent", mechanism: "pull_id_key" },
      },
      function* ({ pullId }) {
        return yield* context.workspace.runScript(input, { operationId: pullId });
      },
    );
  });
