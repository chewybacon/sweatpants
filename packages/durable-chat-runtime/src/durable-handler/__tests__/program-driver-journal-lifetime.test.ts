import { ANY_JSON_SCHEMA_DESCRIPTOR } from "@sweatpants/durable-execution";
import { createCapabilityKeyring, JournalAuthorityPort } from "@sweatpants/journal-authority";
import { ExecutionStoreApi } from "@sweatpants/journal-authority/api";
import { createMemoryExecutionStore } from "@sweatpants/journal-authority/memory";
import { all, run, scoped, useScope, type Scope } from "effection";
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

it("shares one installed journal through helpers and child middleware without per-operation scopes", async () => {
  const journals = createProgramDriverJournalStore({
    keyring,
    executionStore: createMemoryExecutionStore(),
  });
  await run(function* () {
    let controlReads = 0;
    let objectReads = 0;
    yield* ExecutionStoreApi.around({
      *loadControl([id], next) {
        controlReads++;
        return yield* next(id);
      },
      *getObject([pointer], next) {
        objectReads++;
        return yield* next(pointer);
      },
    });
    yield* journals.withJournal("session", function* (journal) {
      const owner = yield* useScope();
      let commandScope: Scope | undefined;
      yield* JournalAuthorityPort.api.around({
        *command([command], next) {
          commandScope = yield* useScope();
          return yield* next(command);
        },
      });
      yield* journal.openTask(request);
      expect(commandScope).toBe(owner);
      controlReads = 0;
      objectReads = 0;
      expect(yield* journal.rootTaskCount("session")).toBe(1);
      expect((yield* journal.readJournal("session")).length).toBeGreaterThan(0);
      let childReads = 0;
      yield* scoped(function* () {
        yield* ExecutionStoreApi.around({
          *loadControl([id], next) {
            childReads++;
            return yield* next(id);
          },
        });
        expect(yield* journal.rootTaskCount("session")).toBe(1);
      });
      expect(childReads).toBe(1);
      expect(controlReads).toBe(3);
      expect(objectReads).toBe(0);
      yield* journals.withJournal("other-conversation", function* (other) {
        expect(yield* other.rootTaskCount("session")).toBe(0);
      });
      expect(yield* journal.rootTaskCount("session")).toBe(1);
    });
  });
});

it("reloads after another authority commits, then reuses that admitted view", async () => {
  const store = createMemoryExecutionStore();
  const journals = createProgramDriverJournalStore({ keyring, executionStore: store });
  await run(() =>
    journals.withJournal("session", function* (journal) {
      const opened = yield* journal.openTask(request);
      expect((yield* journal.recoveryState("session")).status).toBe("active");
      yield* journals.withJournal("session", function* (peer) {
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
    }),
  );
});

it("releases journal installation at lexical exit and persists accepted commits before cleanup", async () => {
  const store = createMemoryExecutionStore();
  const journals = createProgramDriverJournalStore({ keyring, executionStore: store });
  await run(function* () {
    const escaped = yield* journals.withJournal("session", function* (journal) {
      yield* journal.openTask(request);
      expect(yield* store.loadControl("authority:program-driver:session")).not.toBeNull();
      return journal;
    });
    expect(yield* JournalAuthorityPort.isInstalled()).toBe(false);
    let failure: unknown;
    try {
      yield* escaped.rootTaskCount("session");
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: "unknown_target" });
    let objectReads = 0;
    yield* ExecutionStoreApi.around({
      *getObject([pointer], next) {
        objectReads++;
        return yield* next(pointer);
      },
    });
    yield* journals.withJournal("session", function* (reopened) {
      expect(yield* reopened.rootTaskCount("session")).toBe(1);
      expect(objectReads).toBe(1);
    });
  });
});

it("retries an interleaved commit without publishing its losing view", async () => {
  const journals = createProgramDriverJournalStore({
    keyring,
    executionStore: createMemoryExecutionStore(),
  });
  await run(() =>
    journals.withJournal("session", function* (journal) {
      let interleave = true;
      let commits = 0;
      yield* ExecutionStoreApi.around({
        *commitExecution([proposal], next) {
          commits++;
          if (interleave) {
            interleave = false;
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
      yield* journals.withJournal("session", function* (cold) {
        expect(yield* cold.readJournal("session")).toEqual(records);
      });
    }),
  );
});

it("isolates concurrent journal installations while preserving caller middleware", async () => {
  const first = createProgramDriverJournalStore({
    keyring,
    executionStore: createMemoryExecutionStore(),
  });
  const second = createProgramDriverJournalStore({
    keyring,
    executionStore: createMemoryExecutionStore(),
  });
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
    const results = yield* all([
      first.withJournal("session", function* (journal) {
        yield* journal.advance({ type: "execution.open-task", request });
        return yield* journal.rootTaskCount("session");
      }),
      second.withJournal("session", (journal) => journal.rootTaskCount("session")),
    ]);
    expect(results).toEqual([1, 0]);
    expect(advances).toBe(1);
    expect(queries).toBe(2);
  });
});
