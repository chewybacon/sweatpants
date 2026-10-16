import assert from "node:assert/strict";
import { createExecutionService } from "../service.mjs";
import { executionViewSchema } from "../../src/execution/contract.ts";

for (const choice of ["approve", "decline", "cancel"]) {
    const service = createExecutionService();
    let view = executionViewSchema.parse(await service.command({ action: "start" }));
    assert.equal(view.status, "parked");
    assert.deepEqual(view.inspection.calls, ["workflow", "review_draft"]);
    assert.equal(view.pending.key, "approval");
    assert.ok(
        view.inspection.environments.some((env) =>
            env.bindings.some((binding) => binding.name === "input"),
        ),
    );
    assert.ok(view.inspection.cleanups.some((scope) => scope.remaining.length === 1));
    const saved = structuredClone(view.inspection);
    const oldRevision = view.revision;
    view = executionViewSchema.parse(
        await service.command({ action: "restore", id: view.id, revision: view.revision }),
    );
    assert.deepEqual(view.inspection, saved);
    assert.equal(view.trace.filter((event) => event.kind === "kernel.start").length, 1);
    assert.ok(view.trace.some((event) => event.kind === "kernel.restore"));
    await assert.rejects(
        service.command({ action: "reply", id: view.id, revision: oldRevision, choice: "approve" }),
        /Execution changed/,
    );
    assert.equal(service.get(view.id).revision, view.revision);
    view = executionViewSchema.parse(
        await service.command({
            action: choice === "cancel" ? "cancel" : "reply",
            choice,
            id: view.id,
            revision: view.revision,
        }),
    );
    assert.equal(view.pending.key, "cleanup");
    assert.ok(view.inspection.cleanups.some((cleanup) => cleanup.kind === "running"));
    const cleanupState = structuredClone(view.inspection);
    view = executionViewSchema.parse(
        await service.command({ action: "restore", id: view.id, revision: view.revision }),
    );
    assert.deepEqual(view.inspection, cleanupState);
    view = executionViewSchema.parse(
        await service.command({
            action: "reply",
            choice: "release",
            id: view.id,
            revision: view.revision,
        }),
    );
    assert.deepEqual(
        view.result,
        choice === "cancel"
            ? { state: "cancelled" }
            : {
                  state: "completed",
                  value: choice === "approve" ? "Draft approved" : "Draft declined",
              },
    );
    assert.equal(view.pending, null);
    assert.equal(view.inspection.mode, "done");
    const returned = service.get(view.id);
    returned.trace.length = 0;
    assert.ok(service.get(view.id).trace.length > 0, "inspection returns detached data");
    console.log(
        `PASS local inspector: ${choice}, checkpoint restore, cleanup, structured state, stale reply rejection`,
    );
}
