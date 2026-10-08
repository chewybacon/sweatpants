import { describe, expect, it } from "vitest";
import { createSignal, run, scoped, spawn, suspend } from "effection";
import { ExecutionStoreApi, installExecutionStore } from "../api.ts";
import { AcceptedProjectionFactStore } from "../store/fact-store.ts";
import { createMemoryExecutionStore } from "../store/memory.ts";
import { createTurnJournal, type TurnJournal } from "../shell/turn-authority.ts";

const identity = {
  executionId: "execution-1",
  sessionId: "session-1",
  turnId: "turn-1",
  rootTaskId: "root-1",
  rootProgram: { id: "chat", version: "1", digest: "digest-1" },
};

describe("createTurnJournal", () => {
  it("commits accepted facts into a bounded capsule and marks publication idempotently", async () => {
    await run(function* () {
      yield* installExecutionStore(createMemoryExecutionStore());
      const journal = yield* createTurnJournal(identity.executionId);
      yield* journal.open(identity);
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
      const capsule = yield* journal.complete({
        outcome: { storage: "inline", value: "hello" },
        disposition: "completed",
        completedAt: 123,
        facts,
      });

      expect(capsule.publication).toBe("unpublished");
      expect(capsule.projection.throughSequence).toBe(1);
      expect(capsule.projection.facts).not.toBeNull();
      expect(yield* journal.readAcceptedFacts(capsule)).toEqual(facts);

      const published = yield* journal.markPublished();
      expect(published.publication).toBe("published");
      expect((yield* journal.markPublished()).publication).toBe("published");
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
          if (object.objectKind === "projection-facts") {
            calls.push("execution-put");
          }
          return result;
        },
        *getObject([pointer], next) {
          const result = yield* next(pointer);
          if (result?.objectKind === "projection-facts") {
            calls.push("execution-read");
          }
          return result;
        },
      });

      const journal = yield* createTurnJournal(identity.executionId);
      yield* journal.open(identity);
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
      const capsule = yield* journal.complete({
        outcome: { storage: "inline", value: "middleware" },
        disposition: "completed",
        completedAt: 123,
        facts,
      });
      expect(yield* journal.readAcceptedFacts(capsule)).toEqual(facts);
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
        const journal = yield* createTurnJournal(identity.executionId);
        yield* journal.open(identity);
        yield* journal.complete({
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
  it("shares one resource through delegated helpers and rejects use after its owner exits", async () => {
    let escaped!: TurnJournal;
    function* openTurn() {
      const journal = yield* createTurnJournal(identity.executionId);
      yield* journal.open(identity);
      return journal;
    }
    await run(function* () {
      yield* installExecutionStore(createMemoryExecutionStore());
      escaped = yield* openTurn();
      expect((yield* escaped.read())?.executionId).toBe(identity.executionId);
    });
    await expect(
      run(function* () {
        yield* escaped.read();
      }),
    ).rejects.toThrow("Turn journal owning scope has exited");
  });

  it("retains admitted records, isolates returned values, and refreshes after another owner commits", async () => {
    const store = createMemoryExecutionStore();
    await run(function* () {
      yield* installExecutionStore(store);
      const journal = yield* createTurnJournal(identity.executionId);
      const opened = yield* journal.open(identity);
      Reflect.set(opened, "turnId", "caller-mutated");
      expect((yield* journal.read())?.turnId).toBe(identity.turnId);
      const other = yield* createTurnJournal(identity.executionId);
      yield* other.complete({
        outcome: { storage: "inline", value: "done" },
        disposition: "completed",
        completedAt: 123,
        facts: [],
      });
      expect((yield* journal.read())?.format).toBe("sweatpants.terminal-execution.v1");
      yield* journal.markPublished();
      expect(yield* other.read()).toMatchObject({ publication: "published" });
    });
    await run(function* () {
      yield* installExecutionStore(store);
      const restarted = yield* createTurnJournal(identity.executionId);
      expect(yield* restarted.read()).toMatchObject({
        publication: "published",
        turnId: identity.turnId,
      });
    });
  });

  it("recovers a committed record after the acknowledgement fails", async () => {
    const store = createMemoryExecutionStore();
    await run(function* () {
      yield* installExecutionStore(store);
      const journal = yield* createTurnJournal(identity.executionId);
      yield* journal.open(identity);
      let failAcknowledgement = true;
      yield* ExecutionStoreApi.around({
        *commitExecution([request], next) {
          const result = yield* next(request);
          if (failAcknowledgement) {
            failAcknowledgement = false;
            throw new Error("lost acknowledgement");
          }
          return result;
        },
      });
      let failure: unknown;
      try {
        yield* journal.complete({
          outcome: { storage: "inline", value: "done" },
          disposition: "completed",
          completedAt: 123,
          facts: [],
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({ message: "lost acknowledgement" });
      expect(yield* journal.read()).toMatchObject({
        format: "sweatpants.terminal-execution.v1",
        publication: "unpublished",
      });
      expect((yield* journal.markPublished()).publication).toBe("published");
    });
  });
  it("reads the caller's scoped store even when another backend has the same revision and fence", async () => {
    await run(function* () {
      yield* installExecutionStore(createMemoryExecutionStore());
      const journal = yield* createTurnJournal(identity.executionId);
      yield* journal.open(identity);
      yield* scoped(function* () {
        yield* installExecutionStore(createMemoryExecutionStore());
        const other = yield* createTurnJournal(identity.executionId);
        yield* other.open({ ...identity, turnId: "other-turn" });
        expect((yield* journal.read())?.turnId).toBe("other-turn");
      });
      expect((yield* journal.read())?.turnId).toBe(identity.turnId);
    });
  });
  it("rejects a foreign read that resumes after the resource owner exits", async () => {
    await run(function* () {
      yield* installExecutionStore(createMemoryExecutionStore());
      const seed = yield* createTurnJournal(identity.executionId);
      yield* seed.open(identity);
      const ready = createSignal<TurnJournal>();
      const acquired = yield* ready;
      const owner = yield* spawn(function* () {
        const journal = yield* createTurnJournal(identity.executionId);
        ready.send(journal);
        yield* suspend();
      });
      const { value: journal } = yield* acquired.next();
      const reading = createSignal<void>();
      const started = yield* reading;
      const resume = createSignal<void>();
      // A sibling caller deliberately escapes the owner's descendant lifetime.
      const reader = yield* spawn(function* () {
        const released = yield* resume;
        yield* ExecutionStoreApi.around({
          *getObject([pointer], next) {
            const record = yield* next(pointer);
            reading.send();
            yield* released.next();
            return record;
          },
        });
        try {
          return yield* journal.read();
        } catch (error) {
          return error;
        }
      });
      yield* started.next();
      yield* owner.halt();
      resume.send();
      expect(yield* reader).toMatchObject({ message: "Turn journal owning scope has exited" });
      expect((yield* seed.read())?.turnId).toBe(identity.turnId);
    });
  });

  it("refuses a late foreign commit acknowledgement while preserving the persisted completion", async () => {
    await run(function* () {
      yield* installExecutionStore(createMemoryExecutionStore());
      const ready = createSignal<TurnJournal>();
      const acquired = yield* ready;
      const owner = yield* spawn(function* () {
        const journal = yield* createTurnJournal(identity.executionId);
        yield* journal.open(identity);
        ready.send(journal);
        yield* suspend();
      });
      const { value: journal } = yield* acquired.next();
      const persisted = createSignal<void>();
      const committed = yield* persisted;
      const resume = createSignal<void>();
      // Storage has accepted the mutation before this unrelated caller loses its owner.
      const writer = yield* spawn(function* () {
        const released = yield* resume;
        yield* ExecutionStoreApi.around({
          *commitExecution([request], next) {
            const result = yield* next(request);
            persisted.send();
            yield* released.next();
            return result;
          },
        });
        try {
          return yield* journal.complete({
            outcome: { storage: "inline", value: "done" },
            disposition: "completed",
            completedAt: 123,
            facts: [],
          });
        } catch (error) {
          return error;
        }
      });
      yield* committed.next();
      yield* owner.halt();
      resume.send();
      expect(yield* writer).toMatchObject({ message: "Turn journal owning scope has exited" });
      const restarted = yield* createTurnJournal(identity.executionId);
      expect(yield* restarted.read()).toMatchObject({
        format: "sweatpants.terminal-execution.v1",
        publication: "unpublished",
        outcome: { storage: "inline", value: "done" },
      });
    });
  });
});
