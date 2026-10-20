import { reviewDraft } from "./review-draft.workflow.ts";
import { getCompiledWorkflow } from "@sweatpants/flowmode-runtime/compiled-tool";
import luaWasm from "#execution-lua-wasm";
import { createWasmLuaInvoker } from "../../../experiments/workflow-kernel/teal-lua-checkpoint/wasm.mts";
import { createLuaStack } from "./lua.mjs";
import { schemeStack } from "./scheme.mjs";
import { createHootAuthoring } from "../../../experiments/workflow-kernel/hoot-composition/authoring.mjs";
import { DurableObject } from "cloudflare:workers";
import { Scheme } from "../../../.artifacts/hoot-composition/reflect-worker.mjs";
import manifest from "../../../.artifacts/hoot-composition/manifest.json" with { type: "json" };
import { machineApi } from "../../../experiments/workflow-kernel/hoot-composition/machine-api.mjs";
import { createPortableHootProgram } from "../../../experiments/workflow-kernel/hoot-composition/program.mjs";
import { executionServiceFactory } from "./service-core.mjs";
import { createD1Storage } from "@sweatpants/storage-d1";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { createWorkflowModels } from "../src/server/cloudflare/model-catalog.ts";
import { authorCaller } from "../src/execution/author.ts";

const loadMachine = async () => machineApi(await Scheme.load_main("kernel.wasm"));
const identity = {
  kind: "hoot-composition-spike",
  version: manifest.wasm,
  programFormat: "workflow-scheme-spike-1",
  snapshotFormat: "workflow-state-v3",
};
const { createExecutionService, validateCaller, languages, authoring } = executionServiceFactory([
  schemeStack(
    createHootAuthoring({
      loadMachine,
      createProgram: (options) => createPortableHootProgram(options, { loadMachine, identity }),
    }),
    getCompiledWorkflow(reviewDraft, "scheme"),
  ),
  createLuaStack(
    createWasmLuaInvoker(async () => luaWasm),
    getCompiledWorkflow(reviewDraft, "lua"),
  ),
]);

export class ExecutionLab extends DurableObject {
  queue = Promise.resolve();
  fetch(request) {
    const task = this.queue.then(() => this.handle(request));
    this.queue = task.catch(() => {});
    return task;
  }
  async handle(request) {
    try {
      // Reconstruct the service for every request: no warm-instance state is required.
      const service = createExecutionService({
        secret: this.env.PROGRAM_DRIVER_CAPABILITY_SECRET,
        storeFactory: () => createD1Storage(this.env.JOURNAL).executionStore,
        persistence: {
          load: (id) => this.ctx.storage.get(`run:${id}`),
          save: (id, value) => this.ctx.storage.put(`run:${id}`, value),
        },
        author: async (prompt, language) => {
          const credentials = new InMemoryCredentialStore();
          for (const [id, credential] of Object.entries(JSON.parse(this.env.MODEL_CREDENTIALS))) {
            await credentials.modify(id, async () => credential);
          }
          return authorCaller(prompt, (source) => validateCaller(source, language), {
            ...(await authoring(language)),
            models: createWorkflowModels(credentials),
            provider: this.env.DEFAULT_CHAT_MODEL_PROVIDER,
            model: this.env.DEFAULT_CHAT_MODEL_ID,
            thinking: this.env.DEFAULT_CHAT_MODEL_THINKING,
          });
        },
      });
      const url = new URL(request.url);
      const result =
        request.method === "GET"
          ? await service.get(url.searchParams.get("id"))
          : await service.command(await request.json());
      return Response.json(result, { headers: { "Cache-Control": "no-store" } });
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 400 },
      );
    }
  }
}

export async function executionFetch(request, env) {
  const url = new URL(request.url);
  if (
    request.headers.get("origin") &&
    new URL(request.headers.get("origin")).origin !== url.origin
  ) {
    return Response.json({ error: "Same-origin request required" }, { status: 403 });
  }
  let id = url.searchParams.get("id");
  if (request.method === "GET" && !id) {
    return Response.json({ languages });
  }
  if (request.method === "POST") {
    if (!request.headers.get("content-type")?.startsWith("application/json")) {
      return Response.json({ error: "Expected JSON" }, { status: 400 });
    }
    const body = await request.text();
    if (body.length > 16384) {
      return Response.json({ error: "Request too large" }, { status: 413 });
    }
    let command;
    try {
      command = JSON.parse(body);
    } catch {
      return Response.json({ error: "Invalid JSON" }, { status: 400 });
    }
    if (!command || !["start", "reply", "restore", "cancel"].includes(command.action)) {
      return Response.json({ error: "Invalid command" }, { status: 400 });
    }
    id = command.action === "start" ? crypto.randomUUID() : command.id;
    request = new Request(request, {
      method: "POST",
      body: JSON.stringify({ ...command, id }),
    });
  } else if (request.method !== "GET") {
    return new Response(null, { status: 405 });
  }
  if (typeof id !== "string" || !/^[0-9a-f-]{36}$/.test(id)) {
    return Response.json({ error: "Invalid run ID" }, { status: 400 });
  }
  return env.EXECUTION_LABS.get(env.EXECUTION_LABS.idFromName(id)).fetch(request);
}
