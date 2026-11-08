import { createHash, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript-api";
import { verifyWorkflowModule } from "@sweatpan.ts/codemode-compiler";
import { lowerScriptcSources, scriptcCompiler } from "./scriptc.ts";
import { admitToolSource, describeTool } from "./tool-admission.ts";
import { projectTool } from "./tool-project.ts";
import type {
  TypeScriptToolBuildInput,
  WorkflowBuildArtifact,
  WorkflowBuildProvenance,
  WorkflowBuildResult,
} from "./tool-contracts.ts";
export type {
  TypeScriptToolBuildInput,
  ToolBuildContract,
  WorkflowBuildArtifact,
  WorkflowBuildProvenance,
  WorkflowBuildResult,
} from "./tool-contracts.ts";

function canonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  throw new Error("Non-serializable workflow artifact input");
}
const hash = (value: unknown): string =>
  createHash("sha256").update(canonical(value)).digest("hex");
function implementation(): string {
  const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
  return hash(
    ["build", "tool-admission", "tool-project", "scriptc"].map((file) =>
      readFileSync(new URL(`./${file}.${extension}`, import.meta.url), "utf8"),
    ),
  );
}

/** Synchronous Node build operation. Cache is optional, disposable, and trusted local
 * storage. A miss owns ScriptC's subprocess and temporary sources; a hit verifies
 * provenance, integrity and the exact module before returning. No handlers/body run.
 */
export function buildTypeScriptTool(
  input: TypeScriptToolBuildInput,
  options: { readonly cacheDirectory?: string } = {},
): WorkflowBuildResult {
  if (
    input.source.language !== "typescript" ||
    !/^[A-Za-z0-9_-]+\.ts$/.test(input.source.id) ||
    Object.hasOwn(input.modules, input.source.id)
  ) {
    throw new Error("Unsupported tool source identity");
  }
  for (const [id, text] of Object.entries(input.modules)) {
    if (!/^[A-Za-z0-9_-]+\.ts$/.test(id) || typeof text !== "string") {
      throw new Error("Unsupported declaration source identity");
    }
  }
  const declarations = describeTool(input);
  // Admission also runs on hits; it is cheap, deterministic and invokes no compiler process.
  const admitted = admitToolSource(input);
  const provenance: WorkflowBuildProvenance = {
    compiler: scriptcCompiler,
    parser: `typescript-api@${ts.version}`,
    implementation: implementation(),
    profile: "tool-string-outcome/1",
    inputs: {
      entry: input.source.id,
      exportName: input.exportName,
      sources: Object.fromEntries(
        Object.entries({ ...input.modules, [input.source.id]: input.source.text }).map(
          ([id, text]) => [id, hash(text)],
        ),
      ),
      declarations: hash(declarations),
    },
  };
  const key = hash(provenance);
  const path =
    options.cacheDirectory === undefined ? undefined : join(options.cacheDirectory, `${key}.json`);
  if (path) {
    let text: string | undefined;
    try {
      text = readFileSync(path, "utf8");
    } catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") {
        throw error;
      }
    }
    if (text !== undefined) {
      const artifact = JSON.parse(text) as WorkflowBuildArtifact;
      if (
        artifact.format !== "typescript-workflow-build/1" ||
        artifact.key !== key ||
        canonical(artifact.provenance) !== canonical(provenance) ||
        artifact.digest !== hash({ key, provenance, module: artifact.module })
      ) {
        throw new Error("Workflow cache integrity mismatch");
      }
      verifyWorkflowModule(artifact.module);
      return { artifact, cache: "hit" };
    }
  }
  const ir = lowerScriptcSources({ "workflow.ts": admitted.source }, "workflow.ts", ["workflow"]);
  const module = projectTool(ir, admitted);
  const artifact: WorkflowBuildArtifact = {
    format: "typescript-workflow-build/1",
    key,
    provenance,
    module,
    digest: hash({ key, provenance, module }),
  };
  if (path) {
    mkdirSync(options.cacheDirectory!, { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(artifact), { flag: "wx" });
      renameSync(temporary, path);
    } finally {
      rmSync(temporary, { force: true });
    }
  }
  return { artifact, cache: "miss" };
}
