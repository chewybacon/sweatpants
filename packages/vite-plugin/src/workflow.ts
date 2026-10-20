import { analyzeWorkflowTools, workflowSourceDependencies } from "@sweatpants/flowmode-compiler";
import { schemeWorkflowCompiler } from "@sweatpants/flowmode-compiler-scheme";
import { luaWorkflowCompiler } from "@sweatpants/flowmode-compiler-lua";
import { run } from "effection";
import MagicString from "magic-string";
import type { Plugin } from "vite";
import { fileURLToPath } from "node:url";
const WORKFLOW_RUNTIME = "virtual:sweatpants-workflow-runtime";

/** Compile directive-bearing SDK tools in Vite's normal module graph.
 * No disk artifact cache: invalidation and failed transforms cannot serve old data.
 * Imported runtime helpers/values are deliberately unsupported by the compiler;
 * TypeScript imports are watched by the compiler dependency list.
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
          for (const [language, compiler] of [
            ["scheme", schemeWorkflowCompiler],
            ["lua", luaWorkflowCompiler],
          ] as const) {
            const result = await run(() =>
              compiler.compile({
                source: { id, language: "typescript", text: source },
                entry: definition.entry,
                exports: definition.exports,
                bindings: definition.bindings,
              }),
            );
            if (!result.ok) {
              const diagnostic = result.diagnostics.find((d) => d.severity === "error")!;
              this.error({
                message: result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"),
                loc: diagnostic.position
                  ? {
                      file: diagnostic.position.sourceId,
                      line: diagnostic.position.line,
                      column: diagnostic.position.column - 1,
                    }
                  : undefined,
              });
            }
            artifacts[language] = result.module;
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
