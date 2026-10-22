import { readFile } from "node:fs/promises";
import { call, run, type Operation } from "effection";
import { analyzeWorkflowTools } from "@sweatpants/flowmode-compiler";
import { luaWorkflowCompiler } from "@sweatpants/flowmode-compiler-lua";
import { schemeWorkflowCompiler } from "@sweatpants/flowmode-compiler-scheme";
import { requireCompiledWorkflow, type WorkflowRuntimeOptions } from "@sweatpants/flowmode-runtime";
import { invokeWasm } from "@sweatpants/flowmode-runtime-lua/node";
import { createHootAuthoring } from "@sweatpants/flowmode-runtime-scheme/execution/authoring";
import { createHootProgram } from "@sweatpants/flowmode-runtime-scheme/execution/driver";
import { loadMachine } from "@sweatpants/flowmode-runtime-scheme/execution/machine";
import { createMemoryExecutionStore } from "@sweatpants/journal-authority";
import type { ScenarioContext, TestApplication } from "@sweatpants/test-rig";
import { executionServiceFactory } from "../../../execution/service-core.mjs";
import { schemeStack } from "../../../execution/scheme.mjs";
import { createLuaStack } from "../../../execution/lua.mjs";
import { executionViewSchema, type ExecutionView } from "../../execution/contract.ts";

/** Only dependency wiring lives here; scenarios own actions and assertions. */
export async function executionApplication(
  runtimeOptions: Omit<WorkflowRuntimeOptions, "driver"> = {},
) {
  const id = new URL("../../../execution/review-draft.workflow.ts", import.meta.url).pathname;
  const text = await readFile(id, "utf8");
  const request = {
    ...analyzeWorkflowTools(text, id)[0],
    source: { id, text, language: "typescript" },
  };
  const schemeDraft = requireCompiledWorkflow(
    await run(() => schemeWorkflowCompiler.compile(request)),
  );
  const luaDraft = requireCompiledWorkflow(await run(() => luaWorkflowCompiler.compile(request)));
  const scheme = schemeStack(
    createHootAuthoring({ loadMachine, createProgram: createHootProgram }),
    schemeDraft,
  );
  const lua = createLuaStack(invokeWasm, luaDraft);
  // Deterministic caller fixtures compose the real compiled SDK tool and host effect.
  scheme.caller = `(define (workflow input)
    (if (equal? (review_draft input) "Draft approved")
      (send_announcement input) "Draft declined"))
    (workflow %input)`;
  lua.caller = `local result = review_draft(input)
    if result == "Draft approved" then return send_announcement(input) end
    return "Draft declined"`;
  const stacks = [scheme, lua].map((stack) => ({
    ...stack,
    createProgram: (options: Parameters<typeof stack.createProgram>[0]) =>
      stack.createProgram({ ...options, runtimeOptions }),
  }));
  const { createExecutionService } = executionServiceFactory(stacks);
  const store = createMemoryExecutionStore();
  const saved = new Map<string, Record<string, unknown>>();
  return (): TestApplication => {
    let service: ReturnType<typeof createExecutionService> | undefined = createExecutionService({
      secret: "execution-acceptance-only-not-for-deployment",
      storeFactory: () => store,
      persistence: {
        async load(key: string) {
          return structuredClone(saved.get(key));
        },
        async save(key: string, value: Record<string, unknown>) {
          saved.set(key, structuredClone(value));
        },
      },
    });
    return {
      async handle(request) {
        if (!service) {
          throw Error("Execution host disposed");
        }
        try {
          const result =
            request.method === "POST"
              ? await service.command(await request.json())
              : await service.get(new URL(request.url).searchParams.get("id"));
          return Response.json(result);
        } catch (error) {
          return Response.json({ error: String(error) }, { status: 400 });
        }
      },
      async close() {
        service = undefined;
      },
    };
  };
}

/** Public Execution HTTP client; does not drive the journal or kernel directly. */
export function executionClient(s: ScenarioContext): {
  read(id: string): Operation<ExecutionView>;
  command(command: {
    action: string;
    language?: string;
    id?: string;
    revision?: number;
    choice?: string;
  }): Operation<ExecutionView>;
} {
  function* request(path: string, init?: RequestInit): Operation<ExecutionView> {
    const response = yield* call(() => s.transport.fetch(path, init));
    const body = yield* call(() => response.json());
    if (!response.ok) {
      throw Error(JSON.stringify(body));
    }
    return executionViewSchema.parse(body);
  }
  return {
    read: (id: string) => request(`/api/execution?id=${encodeURIComponent(id)}`),
    command: (command: {
      action: string;
      language?: string;
      id?: string;
      revision?: number;
      choice?: string;
    }) =>
      request("/api/execution", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(command),
      }),
  };
}
