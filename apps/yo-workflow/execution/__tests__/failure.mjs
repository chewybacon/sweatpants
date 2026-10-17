import assert from "node:assert/strict";
import { createExecutionService } from "../service.mjs";

// Exercise the HTTP service's projection of a real evaluator failure, not a provider.
const service = createExecutionService({ author: async () => "(missing_workflow)" });
const view = await service.command({ action: "start", prompt: "invalid caller fixture" });
assert.equal(view.result.state, "failed");
assert.deepEqual(view.result.error, {
    code: "workflow_failed",
    message: "Unbound workflow identifier missing_workflow",
});
assert.equal(view.checkpoint, null);
assert.equal(service.get(view.id).result.error.message, view.result.error.message);
console.log("Evaluator errors survive the failed frontier and inspection reload");
