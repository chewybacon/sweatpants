import assert from "node:assert/strict";
import { createExecutionService } from "../service.mjs";
import { executionServiceFactory } from "../service-core.mjs";
import { schemeStack } from "../scheme.mjs";
import { createHootAuthoring } from "../../../../experiments/workflow-kernel/hoot-composition/authoring.mjs";
import { loadMachine } from "../../../../experiments/workflow-kernel/hoot-composition/machine.mjs";
import { createHootProgram } from "../../../../experiments/workflow-kernel/hoot-composition/driver.mjs";
import { reviewDraft } from "../../../../experiments/workflow-kernel/tsdown-authoring/dist/review-draft.workflow.artifact.mjs";
import { createMemoryExecutionStore } from "@sweatpants/journal-authority";

const saved = new Map();
const store = createMemoryExecutionStore();
const options = {
  secret: "recompile-test-secret".repeat(4),
  storeFactory: () => store,
  persistence: {
    async save(id, value) {
      saved.set(id, structuredClone(value));
    },
    async load(id) {
      return structuredClone(saved.get(id));
    },
  },
};
const before = createExecutionService(options);
const parked = await before.command({ action: "start", language: "scheme" });
assert.equal(parked.pending.key, "approval");
// Losing the service instance with the same build still recovers the actual run.
const sameBuild = createExecutionService(options);
assert.equal((await sameBuild.get(parked.id)).pending.key, "approval");
const restored = await sameBuild.command({
  action: "restore",
  id: parked.id,
  revision: parked.revision,
});
assert.equal(restored.pending.key, "approval");

// A changed compiled implementation cannot attach to the previously persisted run.
const edited = structuredClone(reviewDraft);
edited.implementation.payload = edited.implementation.payload.replace(
  "Release the draft reservation?",
  "Release the edited reservation?",
);
const updatedFactory = executionServiceFactory([
  schemeStack(createHootAuthoring({ loadMachine, createProgram: createHootProgram }), edited),
]);
const after = updatedFactory.createExecutionService(options);
await assert.rejects(() => after.get(parked.id), /workflow_source_changed.*Start a new run/);
const fresh = await after.command({ action: "start", language: "scheme" });
assert.equal(fresh.pending.key, "approval");
assert.notEqual(saved.get(fresh.id).programDigest, saved.get(parked.id).programDigest);
assert.equal(saved.get(parked.id).outbox.length, 0);
console.log("PASS recompilation: same-build recovery, changed-build rejection, new-run adoption");
