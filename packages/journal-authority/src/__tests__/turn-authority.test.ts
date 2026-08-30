import { describe, expect, it } from "vitest";
import { run } from "effection";
import { ExecutionStoreApi, installExecutionStore } from "../api.ts";
import { AcceptedProjectionFactStore } from "../store/fact-store.ts";
import { createMemoryExecutionStore } from "../store/memory.ts";
import { TurnJournalAuthority } from "../shell/turn-authority.ts";

const identity = {
  executionId: "execution-1",
  sessionId: "session-1",
  turnId: "turn-1",
  rootTaskId: "root-1",
  rootProgram: { id: "chat", version: "1", digest: "digest-1" },
};

describe("TurnJournalAuthority", () => {
  it("commits accepted facts into a bounded capsule and marks publication idempotently", async () => {
    await run(function* () {
      yield* installExecutionStore(createMemoryExecutionStore());
      yield* TurnJournalAuthority.operations.open(identity);
      const facts = [
        {
          executionId: identity.executionId,
          sessionId: identity.sessionId,
          turnId: identity.turnId,
          sequence: 1,
          kind: "chat.turn.completed",
          payload: { text: "hello" },
        },
      ];
      const capsule = yield* TurnJournalAuthority.operations.complete({
        executionId: identity.executionId,
        outcome: { storage: "inline", value: "hello" },
        disposition: "completed",
        completedAt: 123,
        facts,
      });

      expect(capsule.publication).toBe("unpublished");
      expect(capsule.projection.throughSequence).toBe(1);
      expect(capsule.projection.facts).not.toBeNull();
      expect(yield* TurnJournalAuthority.operations.readAcceptedFacts(capsule)).toEqual(facts);

      const published = yield* TurnJournalAuthority.operations.markPublished(identity.executionId);
      expect(published.publication).toBe("published");
      expect(
        (yield* TurnJournalAuthority.operations.markPublished(identity.executionId)).publication,
      ).toBe("published");
    });
  });

  it("routes accepted fact put/read through both middleware layers", async () => {
    const calls: string[] = [];
    await run(function* () {
      yield* installExecutionStore(createMemoryExecutionStore());
      yield* AcceptedProjectionFactStore.around({
        *put([request], next) {
          calls.push(`fact-put:${request.executionId}`);
          const result = yield* next(request);
          calls.push(`fact-put-done:${result.id}`);
          return result;
        },
        *read([request], next) {
          calls.push(`fact-read:${request.executionId}`);
          const result = yield* next(request);
          calls.push(`fact-read-done:${result.length}`);
          return result;
        },
      });
      yield* ExecutionStoreApi.around({
        *putObject([object], next) {
          const result = yield* next(object);
          if (object.objectKind === "projection-facts") calls.push("execution-put");
          return result;
        },
        *getObject([pointer], next) {
          const result = yield* next(pointer);
          if (result?.objectKind === "projection-facts") calls.push("execution-read");
          return result;
        },
      });

      yield* TurnJournalAuthority.operations.open(identity);
      const facts = [
        {
          executionId: identity.executionId,
          sessionId: identity.sessionId,
          turnId: identity.turnId,
          sequence: 1,
          kind: "chat.turn.completed",
          payload: { text: "middleware" },
        },
      ];
      const capsule = yield* TurnJournalAuthority.operations.complete({
        executionId: identity.executionId,
        outcome: { storage: "inline", value: "middleware" },
        disposition: "completed",
        completedAt: 123,
        facts,
      });
      expect(yield* TurnJournalAuthority.operations.readAcceptedFacts(capsule)).toEqual(facts);
    });

    expect(calls).toEqual([
      "fact-put:execution-1",
      "execution-put",
      expect.stringMatching(/^fact-put-done:/),
      "fact-read:execution-1",
      "execution-read",
      "fact-read-done:1",
    ]);
  });

  it("rejects facts outside the accepted Turn frontier", async () => {
    await expect(
      run(function* () {
        yield* installExecutionStore(createMemoryExecutionStore());
        yield* TurnJournalAuthority.operations.open(identity);
        yield* TurnJournalAuthority.operations.complete({
          executionId: identity.executionId,
          outcome: { storage: "inline", value: "hello" },
          disposition: "completed",
          completedAt: 123,
          facts: [
            {
              executionId: identity.executionId,
              sessionId: identity.sessionId,
              turnId: "other-turn",
              sequence: 1,
              kind: "chat.turn.completed",
              payload: { text: "hello" },
            },
          ],
        });
      }),
    ).rejects.toMatchObject({ code: "turn_authority_boundary_invalid" });
  });
});
