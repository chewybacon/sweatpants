import type { CompileRequest, WorkflowCompiler } from "@sweatpants/flowmode-runtime";
import type { Plugin } from "vite";
import { basename } from "node:path";
import { readFile } from "node:fs/promises";
import { call, run } from "effection";
import { compileWorkflowModule } from "@sweatpants/flowmode-compiler";
/** A Rolldown load hook sees TypeScript before built-in lowering.
 */
export function workflowArtifactPlugin(
  declarations: Omit<CompileRequest, "source">,
  { compiler, artifactName = "artifact" }: { compiler: WorkflowCompiler; artifactName?: string },
): Plugin {
  return {
    name: "sweatpants-workflow",
    async load(id) {
      if (!id.endsWith(".workflow.ts")) {
        return null;
      }
      this.addWatchFile(id);
      return run(function* () {
        const source = yield* call(() => readFile(id, "utf8"));
        const code = yield* compileWorkflowModule(source, id, declarations, compiler);
        const stem = basename(id, ".ts");
        return { code, stem };
      }).then(({ code, stem }) => {
        this.emitFile({ type: "asset", fileName: `${stem}.${artifactName}.mjs`, source: code });
        this.emitFile({
          type: "asset",
          fileName: `${stem}.${artifactName}.d.mts`,
          source: [
            'import type { CompiledWorkflow } from "@sweatpants/flowmode-runtime";',
            'import type { DurableTool } from "@sweatpants/durable-execution";',
            `import type * as tools from "./${stem}.mjs";`,
            "type Artifact<T> = T extends DurableTool<infer I, infer O> ? CompiledWorkflow<I, O> : never;",
            ...declarations.exports.map(
              (e) => `export declare const ${e.name}: Artifact<typeof tools.${e.name}>;`,
            ),
          ].join("\n"),
        });
        return null;
      });
    },
  };
}
