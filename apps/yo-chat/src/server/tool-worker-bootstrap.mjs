// Plain-JS worker bootstrap for yo-chat local tool sessions.
//
// The worker thread must register tsx in-thread before importing workspace
// TypeScript sources; loader hooks are not inherited automatically.
import { register } from "tsx/esm/api";

register();

const { runWorker, createWorkerToolRegistry } =
    await import("../../../../packages/tool-runtime-local/src/worker.ts");
const { toolList } = await import("../__generated__/tool-registry.gen.ts");

function canonicalWorkerTool(tool) {
    return {
        name: tool.name,
        elicits: tool.elicits,
        handler: function* (params, ctx) {
            const invoke = yield* tool(ctx);
            return yield* invoke(params);
        },
    };
}

const registry = createWorkerToolRegistry(toolList.map(canonicalWorkerTool));

await runWorker(registry);
