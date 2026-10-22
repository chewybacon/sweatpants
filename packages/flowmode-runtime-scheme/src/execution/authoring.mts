import type {
  HootKernelDependencies,
  HootProgramOptions,
  createPortableHootProgram,
} from "./program.mts";
import type { WorkflowCompiler, WorkflowImplementation } from "@sweatpants/flowmode-runtime";
import { createWorkflowCompiler } from "@sweatpants/flowmode-runtime";
import { call } from "effection";
import { hootLinker, HOOT_PROGRAM_FORMAT } from "./linker.mts";

export interface HootAuthoringOptions {
  loadMachine: HootKernelDependencies["loadMachine"];
  createProgram: (options: HootProgramOptions) => ReturnType<typeof createPortableHootProgram>;
}

/** Validate and link model-authored Scheme using the selected runtime loader. */
export function createHootAuthoring({ loadMachine, createProgram }: HootAuthoringOptions) {
  const compiler: WorkflowCompiler = createWorkflowCompiler({
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
    createProgram({
      implementation,
      ...options
    }: Omit<HootProgramOptions, "source"> & { implementation: WorkflowImplementation }) {
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
