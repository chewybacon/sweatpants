import { register } from "tsx/esm/api";
import { runWorker, createWorkerToolRegistry } from "@sweatpants/tool-runtime-local/worker";

register();

const workerUrl = new URL(import.meta.url);
const toolsModuleUrl = workerUrl.searchParams.get("tools");
if (!toolsModuleUrl) {
  throw new Error("yo-agent worker bootstrap requires a ?tools=<file-url> query parameter");
}

const toolsModule = await import(toolsModuleUrl);
const loadedTools = Array.isArray(toolsModule.tools)
  ? toolsModule.tools
  : Array.isArray(toolsModule.toolList)
    ? toolsModule.toolList
    : null;

if (!loadedTools) {
  throw new Error(
    `yo-agent worker bootstrap could not find a tools or toolList export in ${toolsModuleUrl}`,
  );
}

const registry = createWorkerToolRegistry(
  loadedTools.map((tool) => ({
    name: tool.name,
    elicits: tool.elicits,
    handler: function* (params, ctx) {
      const invoke = yield* tool(ctx);
      return yield* invoke(params);
    },
  })),
);

await runWorker(registry);
