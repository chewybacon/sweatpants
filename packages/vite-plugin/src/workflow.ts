import {
  analyzeWorkflowTools,
  workflowSourceDependencies,
  prepareWorkflow,
  emitPreparedWorkflow,
} from "@sweatpants/flowmode-compiler";
import { schemeWorkflowTarget } from "@sweatpants/flowmode-compiler-scheme";
import { luaWorkflowTarget } from "@sweatpants/flowmode-compiler-lua";
import MagicString from "magic-string";
import type { Plugin } from "vite";
import { fileURLToPath } from "node:url";
const WORKFLOW_RUNTIME = "virtual:sweatpants-workflow-runtime";

/** Compile directive-bearing SDK tools in Vite's normal module graph.
 * No disk artifact cache: invalidation and failed transforms cannot serve old data.
 * Local helper functions are bundled into the shared typed IR; source/type
 * dependencies are watched before preparation, including failed builds.
 */
export function workflowPlugin(): Plugin {
  return {
    name: "sweatpants:workflow",
    enforce: "pre",
    async resolveId(source) {
      if (source !== WORKFLOW_RUNTIME) {
        return null;
      }
      // Resolve from the integration's dependency, so applications need no extra
      // runtime dependency merely to use the directive. Vite keeps one module identity.
      return this.resolve(
        "@sweatpants/flowmode-runtime/compiled-tool",
        fileURLToPath(import.meta.url),
        { skipSelf: true },
      );
    },
    async transform(source, id) {
      if (
        !/\.[cm]?tsx?$/.test(id) ||
        id.includes("/node_modules/") ||
        !source.includes("use workflow")
      ) {
        return null;
      }
      try {
        const definitions = analyzeWorkflowTools(source, id);
        if (!definitions.length) {
          return null;
        }
        for (const dependency of workflowSourceDependencies(source, id)) {
          this.addWatchFile(dependency);
        }
        let register = "__sweatpantsRegisterCompiled";
        while (source.includes(register)) {
          register += "_";
        }
        const code = new MagicString(source);
        const registrations: string[] = [];
        for (const definition of definitions) {
          const artifacts: Record<string, unknown> = {};
          const prepared = prepareWorkflow({
            source: { id, language: "typescript", text: source },
            entry: definition.entry,
            exports: definition.exports,
            bindings: definition.bindings,
          });
          for (const resolution of prepared.resolutions) {
            const vite = await this.resolve(resolution.specifier, resolution.importer, {
              skipSelf: true,
            });
            if (!vite || vite.external || vite.id !== resolution.resolved) {
              throw Error(
                `Workflow module resolution differs between TypeScript and Vite: ${resolution.specifier} from ${resolution.importer}`,
              );
            }
          }
          const diagnostic = prepared.diagnostics.find((d) => d.severity === "error");
          if (diagnostic) {
            throw Object.assign(
              Error(prepared.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n")),
              { position: diagnostic.position },
            );
          }
          for (const [language, target] of [
            ["scheme", schemeWorkflowTarget],
            ["lua", luaWorkflowTarget],
          ] as const) {
            artifacts[language] = emitPreparedWorkflow(prepared, target);
          }
          registrations.push(
            `${register}(${definition.exportName}, ${JSON.stringify(artifacts)});`,
          );
        }
        code.prepend(
          `import { registerCompiledWorkflows as ${register} } from "${WORKFLOW_RUNTIME}";\n`,
        );
        code.append("\n" + registrations.join("\n"));
        return {
          code: code.toString(),
          map: code.generateMap({ hires: true, source: id, includeContent: true }),
        };
      } catch (error) {
        const failure = error as Error & {
          loc?: { file?: string; line: number; column: number };
          position?: { sourceId: string; line: number; column: number };
        };
        const loc = failure.loc
          ? { ...failure.loc, file: failure.loc.file ?? id }
          : failure.position
            ? {
                file: failure.position.sourceId,
                line: failure.position.line,
                column: failure.position.column - 1,
              }
            : undefined;
        // Worker error transports may discard structured locations. Keep the
        // original author location in the message as well as Vite's code frame.
        this.error({
          message: loc
            ? `${loc.file}:${loc.line}:${loc.column + 1}: ${failure.message}`
            : failure.message,
          loc,
        });
      }
    },
  };
}
