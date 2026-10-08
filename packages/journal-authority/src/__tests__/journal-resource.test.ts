import { run, spawn, type Operation } from "effection";
import { describe, expect, it } from "vitest";
import { ANY_JSON_SCHEMA_DESCRIPTOR } from "@sweatpants/durable-execution";
import { createJournal, ExecutionStorePort, type Journal } from "../index.ts";
import { createCapabilityKeyring } from "../contract/capabilities.ts";
import { createMemoryExecutionStore } from "../store/memory.ts";

const options = {
  journalId: "journal-resource",
  keyring: createCapabilityKeyring("resource-test", [
    { keyId: "test", secret: "journal-resource-test-secret-32-bytes" },
  ]),
};
const request = {
  sessionId: "session",
  taskId: "root",
  turnId: "turn",
  manifest: {
    programId: "resource-test",
    version: "1",
    digest: "a".repeat(64),
    inputSchema: ANY_JSON_SCHEMA_DESCRIPTOR,
    outputSchema: ANY_JSON_SCHEMA_DESCRIPTOR,
    elicits: { card: { response: ANY_JSON_SCHEMA_DESCRIPTOR } },
    effects: {},
    capabilities: { durableEmissions: true, structuredChildren: false, replay: "strict" as const },
  },
  input: null,
  executionEpoch: 1,
  attachmentId: "attachment",
  audience: "workflow-host",
};

describe("journal resource lifetime and advancement", () => {
  it("keeps one owner alive across ordinary helper returns and child operations", async () => {
    const store = createMemoryExecutionStore();
    function* acquire(): Operation<Journal> {
      return yield* createJournal(store, options);
    }
    function* open(journal: Journal) {
      return yield* journal.advance({ type: "execution.open-task", request });
    }
    await run(function* () {
      const journal = yield* acquire();
      expect(yield* store.loadControl(`authority:${options.journalId}`)).toBeNull();
      const opened = yield* open(journal);
      const child = yield* spawn(function* () {
        return yield* journal.advance({
          type: "execution.append-emission",
          request: {
            sessionId: "session",
            taskId: "root",
            actionIndex: 0,
            descriptor: { eventType: "progress", payload: "from child" },
            programCapability: opened.programCapability,
          },
        });
      });
      yield* child;
      // Child teardown must not close the journal acquired by its parent.
      expect((yield* journal.readSession("session")).map((record) => record.payload.type)).toEqual([
        "TaskOpened",
        "DurableEmission",
      ]);
      yield* journal.advance({
        type: "execution.complete-task",
        request: {
          sessionId: "session",
          taskId: "root",
          actionIndex: 1,
          outcome: { status: "ok", value: "done" },
          programCapability: opened.programCapability,
        },
      });
      expect((yield* journal.readSession("session")).at(-1)?.payload.type).toBe("TaskClosed");
    });
  });

  it("rejects an escaped handle after its owner exits without touching storage", async () => {
    const store = createMemoryExecutionStore();
    let reads = 0;
    const measured = {
      ...store,
      *loadControl(id: string) {
        reads++;
        return yield* store.loadControl(id);
      },
    };
    const escaped = await run(function* () {
      const journal = yield* createJournal(measured, options);
      yield* journal.advance({ type: "execution.open-task", request });
      return journal;
    });
    const before = reads;
    await expect(run(() => escaped.exportSnapshot())).rejects.toMatchObject({
      code: "journal_closed",
    });
    await expect(
      run(() => escaped.advance({ type: "execution.open-task", request })),
    ).rejects.toMatchObject({ code: "journal_closed" });
    expect(reads).toBe(before);
    await run(function* () {
      const fresh = yield* createJournal(store, options);
      expect((yield* fresh.readSession("session")).map((record) => record.payload.type)).toEqual([
        "TaskOpened",
      ]);
    });
  });

  it("returns a durable park and resumes through a new owner without repeating the append", async () => {
    const store = createMemoryExecutionStore();
    const parked = await run(function* () {
      const journal = yield* createJournal(store, options);
      const opened = yield* journal.advance({ type: "execution.open-task", request });
      const pending = yield* journal.advance({
        type: "execution.reserve-pull",
        request: {
          sessionId: "session",
          taskId: "root",
          turnId: "turn",
          actionIndex: 0,
          pullIndex: 0,
          descriptor: {
            kind: "elicit",
            key: "card",
            message: "Pick a card",
            response: ANY_JSON_SCHEMA_DESCRIPTOR,
          },
          programCapability: opened.programCapability,
        },
      });
      expect(pending.status).toBe("pending");
      if (pending.status !== "pending" || !pending.resolutionCapability) {
        throw new Error("expected parked picker");
      }
      return {
        capability: pending.resolutionCapability,
        programCapability: opened.programCapability,
        snapshot: yield* journal.exportSnapshot(),
      };
    });
    await run(function* () {
      const journal = yield* createJournal(store, options);
      expect(yield* journal.exportSnapshot()).toEqual(parked.snapshot);
      const response = {
        type: "execution.resolve-pull" as const,
        request: {
          capability: parked.capability,
          audience: "user:card",
          outcome: { status: "ok" as const, value: { action: "accept", content: "ace" } },
        },
      };
      expect(yield* journal.advance(response)).toMatchObject({ status: "accepted" });
      const before = yield* store.loadControl(`authority:${options.journalId}`);
      yield* journal.advance(response);
      expect((yield* store.loadControl(`authority:${options.journalId}`))?.controlRevision).toBe(
        before?.controlRevision,
      );
      expect(
        (yield* journal.readSession("session")).filter(
          (record) => record.payload.type === "PullResolved",
        ),
      ).toHaveLength(1);
    });
  });
});

it("resolves a substituted child store even when both controls have the same revision and fence", async () => {
  const parentStore = createMemoryExecutionStore();
  const childStore = createMemoryExecutionStore();
  await run(function* () {
    yield* ExecutionStorePort.installDriver(parentStore);
    const journal = yield* createJournal(ExecutionStorePort.api.operations, options);
    yield* journal.advance({
      type: "execution.open-task",
      request: { ...request, input: "parent" },
    });
    const parentSnapshot = yield* journal.exportSnapshot();
    const childJournal = yield* createJournal(childStore, options);
    const childOpened = yield* childJournal.advance({
      type: "execution.open-task",
      request: { ...request, input: "child" },
    });
    const childSnapshot = yield* childJournal.exportSnapshot();
    const parentControl = yield* parentStore.loadControl(`authority:${options.journalId}`);
    const childControl = yield* childStore.loadControl(`authority:${options.journalId}`);
    expect(childControl?.controlRevision).toBe(parentControl?.controlRevision);
    expect(childControl?.ownerFence).toBe(parentControl?.ownerFence);

    const reader = yield* spawn(function* () {
      yield* ExecutionStorePort.installDriver(childStore);
      expect(yield* journal.exportSnapshot()).toEqual(childSnapshot);
    });
    yield* reader;
    expect(yield* journal.exportSnapshot()).toEqual(parentSnapshot);
    // Start with the parent's warm view again. The mutation must select the
    // child's control before deciding, not first attempt CAS with the parent.
    const writer = yield* spawn(function* () {
      yield* ExecutionStorePort.installDriver(childStore);
      yield* journal.advance({
        type: "execution.append-emission",
        request: {
          sessionId: "session",
          taskId: "root",
          actionIndex: 0,
          descriptor: { eventType: "progress", payload: "child emission" },
          programCapability: childOpened.programCapability,
        },
      });
      expect(
        yield* journal.query({ type: "task.input", sessionId: "session", taskId: "root" }),
      ).toBe("child");
    });
    yield* writer;
    expect(yield* journal.exportSnapshot()).toEqual(parentSnapshot);
    expect(
      (yield* childJournal.readSession("session")).map((record) => record.payload.type),
    ).toEqual(["TaskOpened", "DurableEmission"]);
  });
});
