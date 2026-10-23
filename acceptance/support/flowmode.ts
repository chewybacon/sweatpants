import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { call, resource, type Operation } from "effection";
import {
  ANY_JSON_SCHEMA_DESCRIPTOR as schema,
  type DurableProgramManifest,
} from "@sweatpants/durable-execution";
import { analyzeWorkflowTools } from "@sweatpants/flowmode-compiler";
import { luaWorkflowCompiler } from "@sweatpants/flowmode-compiler-lua";
import { schemeWorkflowCompiler } from "@sweatpants/flowmode-compiler-scheme";
import { createWorkflowBindingResolver } from "@sweatpants/flowmode-backend";
import {
  requireCompiledWorkflow,
  type WorkflowKernel,
  type CompiledWorkflow,
  type WorkflowBinding,
  type WorkflowCompiler,
  type WorkflowLinker,
  type WorkflowImplementation,
} from "@sweatpants/flowmode-runtime";
import { createLuaAuthoring } from "@sweatpants/flowmode-runtime-lua/authoring";
import { createLuaProgram } from "@sweatpants/flowmode-runtime-lua/program";
import { invokeWasm } from "@sweatpants/flowmode-runtime-lua/node";
import { createHootAuthoring } from "@sweatpants/flowmode-runtime-scheme/execution/authoring";
import { createHootProgram } from "@sweatpants/flowmode-runtime-scheme/execution/driver";
import { loadMachine } from "@sweatpants/flowmode-runtime-scheme/execution/machine";

export const flowmodeLanguages = ["lua", "scheme"] as const;
export type FlowmodeLanguage = (typeof flowmodeLanguages)[number];

export function flowmodeStack(language: FlowmodeLanguage) {
  if (language === "lua") {
    const { luaCompiler, luaLinker } = createLuaAuthoring(invokeWasm);
    return {
      developerCompiler: luaWorkflowCompiler,
      compiler: luaCompiler,
      linker: luaLinker,
      createProgram: (options: Parameters<typeof createLuaProgram>[0]) =>
        createLuaProgram(options, invokeWasm),
      caller: "return review(input)",
    };
  }
  const authoring = createHootAuthoring({ loadMachine, createProgram: createHootProgram });
  return {
    developerCompiler: schemeWorkflowCompiler,
    ...authoring,
    caller: "(define (workflow input) (review input))\n(workflow %input)",
  };
}

export function* compileReview(compiler: WorkflowCompiler) {
  const id = fileURLToPath(new URL("../fixtures/review.workflow.ts", import.meta.url));
  const text = yield* call(() => readFile(id, "utf8"));
  const declaration = analyzeWorkflowTools(text, id)[0];
  if (!declaration) {
    throw new Error("Expected authored workflow declaration");
  }
  return requireCompiledWorkflow(
    yield* compiler.compile({ ...declaration, source: { id, text, language: "typescript" } }),
  );
}

export const reviewContract: Omit<DurableProgramManifest, "digest"> = {
  programId: "acceptance-review",
  version: "1",
  inputSchema: schema,
  outputSchema: schema,
  effects: {},
  elicits: { approval: { response: schema }, cleanup: { response: schema } },
  capabilities: { durableEmissions: true, structuredChildren: false, replay: "strict" },
};

export function elicitResolver(bindings: readonly WorkflowBinding[]) {
  return createWorkflowBindingResolver(bindings, [
    {
      name: "elicit",
      version: "1",
      describe({ input, site }, contract) {
        if (
          !input ||
          typeof input !== "object" ||
          Array.isArray(input) ||
          typeof input["message"] !== "string"
        ) {
          throw new Error("Expected elicitation message");
        }
        return {
          kind: "elicit",
          key: contract.name,
          message: input["message"],
          response: schema,
          binding: { id: site },
        };
      },
    },
  ]);
}

export function* linkReview(
  stack: { compiler: WorkflowCompiler; linker: WorkflowLinker; caller: string },
  definition: CompiledWorkflow,
) {
  const exported = definition.exports[0];
  if (!exported) {
    throw new Error("Missing compiled review export");
  }
  const bindings: WorkflowBinding[] = [
    { kind: "compiled", contract: exported.contract, module: definition, export: exported.name },
    ...definition.imports.map((binding) => ({
      ...binding,
      kind: "host" as const,
      capability: { name: "elicit", version: "1" },
    })),
  ];
  const caller = requireCompiledWorkflow(
    yield* stack.compiler.compile({
      source: {
        id: "acceptance-caller",
        language: stack.compiler.sourceLanguage,
        text: stack.caller,
      },
      entry: "workflow",
      exports: [],
      bindings: bindings.map(({ kind, contract }) => ({ kind, contract })),
    }),
  );
  const implementation: WorkflowImplementation = yield* stack.linker.link({ caller, bindings });
  return {
    implementation,
    bindings,
    contract: reviewContract,
    bindOperation: elicitResolver(bindings),
  };
}

/** Own compute even when a scenario assertion fails before explicit replacement. */
export function useWorkflowKernel(program: { createKernel(): Operation<WorkflowKernel> }) {
  return resource<WorkflowKernel>(function* (provide) {
    const kernel = yield* program.createKernel();
    try {
      yield* provide(kernel);
    } finally {
      yield* kernel.close();
    }
  });
}
