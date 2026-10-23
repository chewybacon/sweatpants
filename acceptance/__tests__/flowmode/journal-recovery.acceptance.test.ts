// @vitest-environment node
import { run } from "effection";
import { describe, expect, it } from "vitest";
import {
  compileReview,
  flowmodeLanguages,
  flowmodeStack,
  linkReview,
} from "../../support/flowmode.ts";
import { openStorageRig, storageVariants } from "../../support/storage/index.ts";
import { useProgramRig } from "../../support/program.ts";

describe.each(flowmodeLanguages)("%s durable driver", (language) => {
  it.each(storageVariants)(
    "recovers approval and cleanup from the %s journal with fresh drivers",
    async (variant) => {
      const storage = await openStorageRig(variant);
      try {
        const connection = await storage.open();
        if (connection.storage.kind !== "custom") {
          throw new Error("Expected composed storage");
        }
        const store = connection.storage.executionStore;
        await run(function* () {
          // Arrange: developer source and caller become a pinned durable program.
          const stack = flowmodeStack(language);
          const definition = yield* compileReview(stack.developerCompiler);
          const options = yield* linkReview(stack, definition);
          const program = stack.createProgram(options);
          const first = yield* useProgramRig(store, program, { title: "Publish?" });
          yield* first.journal.advance({
            type: "execution.open-task",
            request: {
              ...first.attach,
              turnId: "turn",
              manifest: program.manifest,
              attachmentId: "unattached",
              audience: "acceptance",
            },
          });

          // Act: the shared driver persists the compiled tool's approval request.
          const approval = yield* first.advance();
          expect(approval.state).toBe("parked");
          if (approval.state !== "parked") {
            throw new Error("Expected approval park");
          }
          const records = yield* first.journal.readSession(first.attach.sessionId);
          expect(
            records
              .filter((entry) => entry.payload.type === "PullRequested")
              .map((entry) => entry.payload),
          ).toMatchObject([
            { descriptor: { kind: "elicit", key: "approval", message: "Publish?" } },
          ]);
          const capability = yield* first.journal.query({
            type: "pull.resolution-capability",
            sessionId: first.attach.sessionId,
            taskId: "root",
            pullId: approval.pullId,
          });
          const accepted = yield* first.journal.advance({
            type: "execution.resolve-pull",
            request: {
              capability,
              audience: "user:approval",
              outcome: { status: "ok", value: { action: "accept", content: { approved: true } } },
            },
          });
          expect(accepted.status).not.toBe("rejected");

          // Act: reconstruct program, authority and driver; cleanup must still run.
          const second = yield* useProgramRig(store, stack.createProgram(options), {
            title: "Publish?",
          });
          const cleanup = yield* second.advance();
          expect(cleanup.state).toBe("parked");
          if (cleanup.state !== "parked") {
            throw new Error("Expected cleanup park");
          }
          expect(cleanup.pullId).not.toBe(approval.pullId);
          const cleanupCapability = yield* second.journal.query({
            type: "pull.resolution-capability",
            sessionId: second.attach.sessionId,
            taskId: "root",
            pullId: cleanup.pullId,
          });
          const released = yield* second.journal.advance({
            type: "execution.resolve-pull",
            request: {
              capability: cleanupCapability,
              audience: "user:cleanup",
              outcome: { status: "ok", value: { action: "accept", content: { approved: true } } },
            },
          });
          expect(released.status).not.toBe("rejected");

          // Assert: another replacement completes without duplicating accepted pulls.
          const third = yield* useProgramRig(store, stack.createProgram(options), {
            title: "Publish?",
          });
          expect(yield* third.advance()).toEqual({ state: "completed", value: "approved" });
          const journal = yield* third.journal.readSession(third.attach.sessionId);
          expect(
            journal
              .filter((entry) => entry.payload.type === "PullRequested")
              .map((entry) => entry.payload),
          ).toMatchObject([
            { descriptor: { kind: "elicit", key: "approval" } },
            { descriptor: { kind: "elicit", key: "cleanup" } },
          ]);
        });
      } finally {
        await storage.close();
      }
    },
  );
});
