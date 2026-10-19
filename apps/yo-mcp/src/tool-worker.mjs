import { register } from "tsx/esm/api";

register();

const { runWorker, createWorkerToolRegistry, createWorkerTool } =
  await import("../../../packages/tool-runtime-local/src/worker.ts");
const { allTools } = await import("./tools/index.ts");

const registry = createWorkerToolRegistry(allTools.map((tool) => createWorkerTool(tool)));

await runWorker(registry);
