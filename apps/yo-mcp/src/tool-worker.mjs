import { register } from "tsx/esm/api";

register();

const { runWorker, createWorkerToolRegistry } =
    await import("../../../packages/tool-runtime-local/src/worker.ts");
const { allTools } = await import("./tools/index.ts");

const registry = createWorkerToolRegistry(
    allTools.map((tool) => ({
        name: tool.name,
        elicits: tool.elicits,
        handler: function* (params, ctx) {
            const invoke = yield* tool(ctx);
            return yield* invoke(params);
        },
    })),
);

await runWorker(registry);
