import { createDurableTool, defineEffect } from "@sweatpants/core";
import { z } from "zod";

const RelativePath = z
  .string()
  .min(1)
  .max(1_024)
  .refine((value) => !value.startsWith("/") && !value.split("/").includes(".."), {
    message: "path must stay within the workspace",
  });

const InspectWorkspaceOutput = z.object({ workspaceVersion: z.string() });
const ReadWorkspaceInput = z.object({ path: RelativePath, workspaceVersion: z.string() });
const ListWorkspaceInput = z.object({ path: RelativePath, workspaceVersion: z.string() });
const ListWorkspaceOutput = z.object({
  path: RelativePath,
  entries: z.array(z.string()),
  workspaceVersion: z.string(),
});
const ReadWorkspaceOutput = z.object({
  path: RelativePath,
  content: z.string(),
  workspaceVersion: z.string(),
});
const WriteWorkspaceInput = z.object({
  path: RelativePath,
  content: z.string().max(1024 * 1024),
  expectedWorkspaceVersion: z.string(),
});
const WriteWorkspaceOutput = z.object({
  path: RelativePath,
  bytes: z.number().int().nonnegative(),
  workspaceVersion: z.string(),
});
const RunWorkspaceScriptInput = z.object({
  script: z.enum(["test", "typecheck", "lint"]),
  workspaceVersion: z.string(),
});
const RunWorkspaceScriptOutput = z.object({
  script: z.string(),
  exitCode: z.number().int(),
  stdout: z.string(),
  stderr: z.string(),
  workspaceVersion: z.string(),
});

export const inspectWorkspace = defineEffect({
  name: "yo-studio.workspace.inspect",
  version: "1",
  input: z.object({}),
  output: InspectWorkspaceOutput,
  retrySafety: { mode: "idempotent", mechanism: "inherent" },
});

export const readWorkspaceFile = defineEffect({
  name: "yo-studio.workspace.read",
  version: "1",
  input: ReadWorkspaceInput,
  output: ReadWorkspaceOutput,
  retrySafety: { mode: "idempotent", mechanism: "inherent" },
});

export const listWorkspace = defineEffect({
  name: "yo-studio.workspace.list",
  version: "1",
  input: ListWorkspaceInput,
  output: ListWorkspaceOutput,
  retrySafety: { mode: "idempotent", mechanism: "inherent" },
});

export const writeWorkspaceFile = defineEffect({
  name: "yo-studio.workspace.write",
  version: "1",
  input: WriteWorkspaceInput,
  output: WriteWorkspaceOutput,
  retrySafety: { mode: "idempotent", mechanism: "pull_id_key" },
});

export const runWorkspaceScript = defineEffect({
  name: "yo-studio.workspace.run-script",
  version: "1",
  input: RunWorkspaceScriptInput,
  output: RunWorkspaceScriptOutput,
  retrySafety: { mode: "idempotent", mechanism: "pull_id_key" },
});

export const workspaceInspectTool = createDurableTool("workspace_inspect", { version: "1.0.0" })
  .description("Return the current logical workspace version")
  .parameters(z.object({}))
  .output(InspectWorkspaceOutput)
  .effects({ [inspectWorkspace.name]: inspectWorkspace })
  .execute(function* (_input, context) {
    return yield* context.effect(inspectWorkspace, {});
  });

export const workspaceReadTool = createDurableTool("workspace_read", { version: "1.0.0" })
  .description("Read one UTF-8 file from the task workspace")
  .parameters(ReadWorkspaceInput)
  .output(ReadWorkspaceOutput)
  .effects({ [readWorkspaceFile.name]: readWorkspaceFile })
  .execute(function* (input, context) {
    return yield* context.effect(readWorkspaceFile, input);
  });

export const workspaceListTool = createDurableTool("workspace_list", { version: "1.0.0" })
  .description("List one directory at an expected logical workspace version")
  .parameters(ListWorkspaceInput)
  .output(ListWorkspaceOutput)
  .effects({ [listWorkspace.name]: listWorkspace })
  .execute(function* (input, context) {
    return yield* context.effect(listWorkspace, input);
  });

export const workspaceWriteTool = createDurableTool("workspace_write", { version: "1.0.0" })
  .description("Replace one UTF-8 file at an expected logical workspace version")
  .parameters(WriteWorkspaceInput)
  .output(WriteWorkspaceOutput)
  .effects({ [writeWorkspaceFile.name]: writeWorkspaceFile })
  .execute(function* (input, context) {
    return yield* context.effect(writeWorkspaceFile, input);
  });

export const workspaceTestTool = createDurableTool("workspace_test", { version: "1.0.0" })
  .description("Run one deployment-declared validation script in the task workspace")
  .parameters(RunWorkspaceScriptInput)
  .output(RunWorkspaceScriptOutput)
  .effects({ [runWorkspaceScript.name]: runWorkspaceScript })
  .execute(function* (input, context) {
    return yield* context.effect(runWorkspaceScript, input);
  });

export const codingCapabilities = {
  workspace_inspect: workspaceInspectTool,
  workspace_read: workspaceReadTool,
  workspace_list: workspaceListTool,
  workspace_write: workspaceWriteTool,
  workspace_test: workspaceTestTool,
} as const;
