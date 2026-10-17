import assert from "node:assert/strict";
import { registerHooks } from "node:module";
// This process consumes build output. Compiling on import would violate the seam.
registerHooks({
    resolve(specifier, context, nextResolve) {
        if (
            specifier.includes("scheme-compiler") ||
            specifier.includes("@babel") ||
            specifier === "tsdown"
        )
            throw Error(`Runtime tried to load compiler: ${specifier}`);
        return nextResolve(specifier, context);
    },
});
const { reviewDraft } = await import("../dist/review-draft.workflow.mjs");
assert.equal(reviewDraft.kind, "compiled-workflow");
assert.equal(reviewDraft.entry, "review_draft");
assert.deepEqual(JSON.parse(JSON.stringify(reviewDraft)), reviewDraft);
const { createExecutionService } =
    await import("../../../../apps/yo-workflow/execution/service.mjs");
const service = createExecutionService({
    author: async () =>
        `(define (workflow input) (let ((answer (review_draft input))) (if (equal? answer "Draft approved") (send_announcement input) answer))) (workflow %input)`,
});
let view = await service.command({ action: "start", prompt: "review and send" });
assert.equal(view.pending.key, "approval");
view = await service.command({ action: "restore", id: view.id, revision: view.revision });
view = await service.command({
    action: "reply",
    choice: "approve",
    id: view.id,
    revision: view.revision,
});
assert.equal(view.pending.key, "cleanup");
assert.equal(view.outbox.length, 0);
view = await service.command({ action: "restore", id: view.id, revision: view.revision });
view = await service.command({
    action: "reply",
    choice: "release",
    id: view.id,
    revision: view.revision,
});
assert.equal(view.result.state, "completed");
assert.equal(view.outbox.length, 1);
assert.equal(view.result.value.announcementId, view.outbox[0].announcementId);
console.log(
    "Compiled import runs, restores both boundaries, cleans up and composes with host tool without loading compiler",
);
