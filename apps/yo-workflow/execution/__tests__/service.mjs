import assert from "node:assert/strict";
import { createExecutionService } from "../service.mjs";
import { executionViewSchema } from "../../src/execution/contract.ts";

for (const language of ["scheme", "lua"]) {
  for (const choice of ["approve", "decline", "cancel", "cancel-cleanup"]) {
    const service = createExecutionService();
    let view = executionViewSchema.parse(await service.command({ action: "start", language }));
    assert.equal(view.status, "parked");
    assert.equal(view.language.id, language);
    if (language === "scheme") {
      assert.deepEqual(view.inspection.calls, ["workflow", "review_draft"]);

      assert.ok(
        view.inspection.environments.some((env) =>
          env.bindings.some((binding) => binding.name === "input"),
        ),
      );
      assert.ok(view.inspection.cleanups.some((scope) => scope.remaining.length === 1));
    }
    assert.equal(view.pending.key, "approval");
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
        choice: choice === "cancel-cleanup" ? "approve" : choice,
        id: view.id,
        revision: view.revision,
      }),
    );
    assert.equal(view.pending.key, "cleanup");
    if (language === "scheme") {
      assert.ok(view.inspection.cleanups.some((cleanup) => cleanup.kind === "running"));
    }
    if (choice === "cancel-cleanup") {
      view = executionViewSchema.parse(
        await service.command({ action: "cancel", id: view.id, revision: view.revision }),
      );
      assert.equal(view.pending.key, "cleanup");
    }
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
      choice.startsWith("cancel")
        ? { state: "cancelled" }
        : {
            state: "completed",
            value: choice === "approve" ? "Draft approved" : "Draft declined",
          },
    );
    assert.equal(view.pending, null);
    assert.equal(
      view.trace.filter((event) => event.kind === "kernel.start").length,
      1,
      "later activations restore the guest rather than restart its prefix",
    );
    assert.equal(
      view.inspection.mode,
      language === "scheme" ? "done" : choice.startsWith("cancel") ? "cancelled" : "completed",
    );
    const returned = service.get(view.id);
    returned.trace.length = 0;
    assert.ok(service.get(view.id).trace.length > 0, "inspection returns detached data");
    console.log(
      `PASS local inspector: ${language}/${choice}, checkpoint restore, cleanup, structured state, stale reply rejection`,
    );
  }
}
