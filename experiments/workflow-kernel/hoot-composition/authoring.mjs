import { createWorkflowCompiler } from "../../../packages/workflow-kernel/dist/index.js";
import { call } from "effection";
import { hootLinker, HOOT_PROGRAM_FORMAT } from "./linker.mts";

/** Current Hoot composition root. The app consumes validation, linking and preparation seams. */
export function createHootAuthoring({ loadMachine, createProgram }) {
  /** @type {import('../../../packages/workflow-kernel/src/index.ts').WorkflowCompiler} */
  const compiler = createWorkflowCompiler({
    driver: {
      sourceLanguage: "scheme",
      definitionFormat: hootLinker.definitionFormat,
      *compile({ source, entry, exports, bindings }) {
        if (source.language !== "scheme") {
          return {
            ok: false,
            diagnostics: [
              {
                severity: "error",
                code: "source_language",
                message: "Hoot requires Scheme caller source",
              },
            ],
          };
        }
        const machine = yield* call(loadMachine);
        const message = machine.validate(source.text);
        if (message) {
          return {
            ok: false,
            diagnostics: [{ severity: "error", code: "scheme_compile", message }],
          };
        }
        return {
          ok: true,
          diagnostics: [],
          module: {
            source,
            entry,
            exports,
            imports: bindings,
            implementation: { format: hootLinker.definitionFormat, payload: source.text },
            debug: { sites: {}, locations: {} },
          },
        };
      },
    },
  });
  return {
    linker: hootLinker,
    compiler,
    createProgram({ implementation, ...options }) {
      if (
        implementation.format !== HOOT_PROGRAM_FORMAT ||
        typeof implementation.payload !== "string"
      ) {
        throw Error("Incompatible Hoot program implementation");
      }
      return createProgram({ ...options, source: implementation.payload });
    },
  };
}
