import { ANY_JSON_SCHEMA_DESCRIPTOR } from "@sweatpants/durable-execution";
import { createCapabilityKeyring, JournalAuthorityPort } from "@sweatpants/journal-authority";
import { ExecutionStoreApi } from "@sweatpants/journal-authority/api";
import { createMemoryExecutionStore } from "@sweatpants/journal-authority/memory";
import { run, scoped } from "effection";
import { expect, it } from "vitest";
import { createProgramDriverJournalStore } from "../program-driver-journal.ts";

const keyring = createCapabilityKeyring("test", [
  { keyId: "test", secret: "test-secret-material-at-least-32-bytes" },
]);
const request = {
  sessionId: "session",
  turnId: "turn",
  taskId: "root",
  manifest: {
    programId: "scope-lifetime",
    version: "1",
    digest: "a".repeat(64),
    inputSchema: ANY_JSON_SCHEMA_DESCRIPTOR,
    outputSchema: ANY_JSON_SCHEMA_DESCRIPTOR,
    elicits: {},
    effects: {},
    capabilities: { durableEmissions: true, structuredChildren: false, replay: "strict" as const },
  },
  input: null,
  executionEpoch: 1,
  attachmentId: "attachment",
  audience: "workflow-host",
};

it("shares the committed view across helper scopes while keeping scoped middleware and control reads", async () => {
  const journals = createProgramDriverJournalStore({
    keyring,
    executionStore: createMemoryExecutionStore(),
  });
  await run(function* () {
    let controlReads = 0;
    let objectReads = 0;
    let journalReads = 0;
    yield* ExecutionStoreApi.around({
      *loadControl([id], next) {
        controlReads++;
        return yield* next(id);
      },
      *getObject([pointer], next) {
        objectReads++;
        return yield* next(pointer);
      },
      *readJournal([pointer], next) {
        journalReads++;
        return yield* next(pointer);
      },
    });
    const journal = yield* journals.open("session");
    yield* journal.openTask(request);
    controlReads = 0;
    objectReads = 0;
    journalReads = 0;
    expect(yield* journal.rootTaskCount("session")).toBe(1);
    expect((yield* journal.readJournal("session")).length).toBeGreaterThan(0);
    let childControlReads = 0;
    yield* scoped(function* () {
      yield* ExecutionStoreApi.around({
        *loadControl([id], next) {
          childControlReads++;
          return yield* next(id);
        },
      });
      yield* journal.install();
      expect(
        yield* JournalAuthorityPort.api.operations.query({
          type: "session.root-task-count",
          sessionId: "session",
        }),
      ).toBe(1);
    });
    expect(childControlReads).toBe(1);
    expect(controlReads).toBe(3);
    expect(objectReads).toBe(0);
    expect(journalReads).toBe(0);
    const other = yield* journals.open("other-conversation");
    expect(yield* other.rootTaskCount("session")).toBe(0);
    expect(yield* journal.rootTaskCount("session")).toBe(1);
  });
});

it("reloads after another authority commits, then reuses that validated view", async () => {
  const store = createMemoryExecutionStore();
  const journals = createProgramDriverJournalStore({ keyring, executionStore: store });
  await run(function* () {
    const journal = yield* journals.open("session");
    const opened = yield* journal.openTask(request);
    expect((yield* journal.recoveryState("session")).status).toBe("active");
    yield* scoped(function* () {
      const peer = yield* journals.open("session");
      yield* peer.advance({
        type: "execution.complete-task",
        request: {
          sessionId: "session",
          taskId: "root",
          actionIndex: 0,
          outcome: { status: "ok", value: "done" },
          programCapability: opened.programCapability,
        },
      });
    });
    let objectReads = 0;
    yield* ExecutionStoreApi.around({
      *getObject([pointer], next) {
        objectReads++;
        return yield* next(pointer);
      },
    });
    expect(yield* journal.recoveryState("session")).toMatchObject({
      status: "terminal",
      outcome: { status: "ok", value: "done" },
    });
    expect(objectReads).toBe(1);
    expect((yield* journal.recoveryState("session")).status).toBe("terminal");
    expect(objectReads).toBe(1);
  });
});

it("releases the view when its owning scope exits without deferring an accepted commit to cleanup", async () => {
  const store = createMemoryExecutionStore();
  const journals = createProgramDriverJournalStore({ keyring, executionStore: store });
  const closed = await run(function* () {
    const journal = yield* journals.open("session");
    yield* journal.openTask(request);
    // Durable acceptance is visible before this owner exits.
    expect(yield* store.loadControl("authority:program-driver:session")).not.toBeNull();
    return journal;
  });
  await expect(run(() => closed.rootTaskCount("session"))).rejects.toThrow(
    "owning scope has exited",
  );
  await run(function* () {
    let objectReads = 0;
    yield* ExecutionStoreApi.around({
      *getObject([pointer], next) {
        objectReads++;
        return yield* next(pointer);
      },
    });
    const reopened = yield* journals.open("session");
    expect(yield* reopened.rootTaskCount("session")).toBe(1);
    expect(objectReads).toBe(1);
  });
});

it("retries an interleaved commit on the same instance without publishing the losing view", async () => {
  const journals = createProgramDriverJournalStore({
    keyring,
    executionStore: createMemoryExecutionStore(),
  });
  await run(function* () {
    const journal = yield* journals.open("session");
    let interleave = true;
    let commits = 0;
    yield* ExecutionStoreApi.around({
      *commitExecution([proposal], next) {
        commits++;
        if (interleave) {
          interleave = false;
          // Suspend the first proposal while another operation on this same
          // authority commits. The original proposal must lose its CAS.
          yield* journal.openTask({ ...request, taskId: "peer", turnId: "peer-turn" });
        }
        return yield* next(proposal);
      },
    });
    yield* journal.openTask(request);
    expect(commits).toBe(3);
    expect(yield* journal.rootTaskCount("session")).toBe(2);
    const records = yield* journal.readJournal("session");
    expect(
      records
        .filter((record) => record.payload.type === "TaskOpened")
        .map((record) => record.payload.taskId),
    ).toEqual(["peer", "root"]);
    const cold = yield* journals.open("session");
    expect(yield* cold.readJournal("session")).toEqual(records);
  });
});

it("routes resource operations through caller middleware while selecting each journal's store", async () => {
  const firstStore = createMemoryExecutionStore();
  const secondStore = createMemoryExecutionStore();
  await run(function* () {
    let advances = 0;
    let queries = 0;
    yield* JournalAuthorityPort.api.around({
      *command([command], next) {
        advances++;
        return yield* next(command);
      },
      *query([query], next) {
        queries++;
        return yield* next(query);
      },
    });
    // Identical journal identities in different stores must never share accepted state.
    const first = yield* createProgramDriverJournalStore({
      keyring,
      executionStore: firstStore,
    }).open("session");
    const second = yield* createProgramDriverJournalStore({
      keyring,
      executionStore: secondStore,
    }).open("session");
    yield* first.advance({ type: "execution.open-task", request });
    expect(yield* first.query({ type: "session.root-task-count", sessionId: "session" })).toBe(1);
    expect(yield* second.query({ type: "session.root-task-count", sessionId: "session" })).toBe(0);
    expect(advances).toBe(1);
    expect(queries).toBe(2);
    let childQueries = 0;
    yield* scoped(function* () {
      yield* JournalAuthorityPort.api.around({
        *query([query], next) {
          childQueries++;
          return yield* next(query);
        },
      });
      expect(yield* first.rootTaskCount("session")).toBe(1);
      expect(yield* second.rootTaskCount("session")).toBe(0);
    });
    expect(childQueries).toBe(2);
    expect(queries).toBe(4);
  });
});
