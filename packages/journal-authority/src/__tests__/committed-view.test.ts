import { ANY_JSON_SCHEMA_DESCRIPTOR } from "@sweatpants/durable-execution";
import { run } from "effection";
import type { Json } from "@sweatpants/foundation";
import { expect, it } from "vitest";
import { createCapabilityKeyring } from "../contract/capabilities.ts";
import { createStoredShellDrivers } from "../shell/stored-shell.ts";
import { createMemoryExecutionStore } from "../store/memory.ts";
import type { AuthorityCommand } from "../contract/authority-contract.ts";
import type { ExecutionStore } from "../store/store.ts";

const options = {
  journalId: "committed-view",
  now: () => 1000,
  keyring: createCapabilityKeyring("test", [
    { keyId: "test", secret: "test-secret-material-at-least-32-bytes" },
  ]),
};
const request = {
  sessionId: "session",
  turnId: "turn",
  taskId: "root",
  manifest: {
    programId: "committed-view",
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

it("discards a losing candidate when a competing commit makes the retry idempotent", async () => {
  const store = createMemoryExecutionStore();
  const peer = createStoredShellDrivers(store, options);
  let complete: AuthorityCommand;
  let attempts = 0;
  let objectReads = 0;
  let journalReads = 0;
  const measured: ExecutionStore = {
    ...store,
    *commitExecution(proposal) {
      if (attempts++ === 0) {
        yield* peer.authority.command(complete);
      }
      return yield* store.commitExecution(proposal);
    },
    *getObject(pointer) {
      objectReads++;
      return yield* store.getObject(pointer);
    },
    *readJournal(pointer) {
      journalReads++;
      return yield* store.readJournal(pointer);
    },
  };
  await run(function* () {
    const opened = yield* peer.authority.command({ type: "execution.open-task", request });
    complete = {
      type: "execution.complete-task",
      request: {
        sessionId: request.sessionId,
        taskId: request.taskId,
        actionIndex: 0,
        outcome: { status: "ok", value: "done" },
        programCapability: opened.programCapability,
      },
    };
    const drivers = createStoredShellDrivers(measured, options);
    yield* drivers.authority.command(complete);
    expect(attempts).toBe(1);
    expect(objectReads).toBe(2);
    expect(journalReads).toBe(2);
    const accepted = yield* drivers.snapshot.exportSnapshot();
    expect(objectReads).toBe(2);
    expect(journalReads).toBe(2);
    const cold = createStoredShellDrivers(store, options);
    expect(accepted).toEqual(yield* cold.snapshot.exportSnapshot());
  });
});

it("never exposes a candidate rejected by the owner fence", async () => {
  const store = createMemoryExecutionStore();
  let reject = false;
  const measured: ExecutionStore = {
    ...store,
    *commitExecution(proposal) {
      if (reject) {
        return {
          status: "stale_owner",
          current: (yield* store.loadControl(proposal.executionId))!,
        };
      }
      return yield* store.commitExecution(proposal);
    },
  };
  await run(function* () {
    const drivers = createStoredShellDrivers(measured, options);
    const opened = yield* drivers.authority.command({ type: "execution.open-task", request });
    const before = yield* drivers.snapshot.exportSnapshot();
    reject = true;
    let error: unknown;
    try {
      yield* drivers.authority.command({
        type: "execution.append-emission",
        request: {
          sessionId: request.sessionId,
          taskId: request.taskId,
          actionIndex: 0,
          descriptor: { eventType: "progress", payload: "unaccepted" },
          programCapability: opened.programCapability,
        },
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: "stale_owner" });
    expect(yield* drivers.snapshot.exportSnapshot()).toEqual(before);
    expect(yield* createStoredShellDrivers(store, options).snapshot.exportSnapshot()).toEqual(
      before,
    );
  });
});

it("rejects unrestorable mutations before staging or committing any data", async () => {
  const store = createMemoryExecutionStore();
  let writes = 0;
  const measured: ExecutionStore = {
    ...store,
    *putObject(value) {
      writes++;
      return yield* store.putObject(value);
    },
    *commitExecution(value) {
      writes++;
      return yield* store.commitExecution(value);
    },
  };
  let input: Json = null;
  for (let depth = 0; depth < 140; depth++) input = { nested: input };
  await run(function* () {
    const drivers = createStoredShellDrivers(measured, options);
    let error: unknown;
    try {
      yield* drivers.authority.command({
        type: "execution.open-task",
        request: { ...request, input },
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: "invalid_journal" });
    expect(writes).toBe(0);
    expect(yield* store.loadControl("authority:committed-view")).toBeNull();
    expect(yield* drivers.snapshot.exportSnapshot()).toEqual(
      yield* createStoredShellDrivers(store, options).snapshot.exportSnapshot(),
    );
    const opened = yield* drivers.authority.command({ type: "execution.open-task", request });
    const before = yield* drivers.snapshot.exportSnapshot();
    writes = 0;
    error = undefined;
    try {
      yield* drivers.authority.command({
        type: "execution.append-emission",
        request: {
          sessionId: "session",
          taskId: "root",
          actionIndex: 0,
          descriptor: { eventType: "progress", payload: input },
          programCapability: opened.programCapability,
        },
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: "invalid_journal" });
    expect(writes).toBe(0);
    expect(yield* drivers.snapshot.exportSnapshot()).toEqual(before);
    expect(yield* createStoredShellDrivers(store, options).snapshot.exportSnapshot()).toEqual(
      before,
    );
  });
});

it("isolates warm query results and observes a peer mutation before the next command", async () => {
  const store = createMemoryExecutionStore();
  await run(function* () {
    const drivers = createStoredShellDrivers(store, options);
    const peer = createStoredShellDrivers(store, options);
    const opened = yield* drivers.authority.command({
      type: "execution.open-task",
      request: { ...request, input: { nested: { value: "original" } } },
    });
    const query = { type: "task.input", sessionId: "session", taskId: "root" } as const;
    const input = yield* drivers.authority.query(query);
    expect(input).toEqual({ nested: { value: "original" } });
    Reflect.set(input as object, "nested", { value: "changed by reader" });
    expect(yield* drivers.authority.query(query)).toEqual({ nested: { value: "original" } });
    yield* peer.authority.command({
      type: "execution.append-emission",
      request: {
        sessionId: "session",
        taskId: "root",
        actionIndex: 0,
        descriptor: { eventType: "progress", payload: "peer" },
        programCapability: opened.programCapability,
      },
    });
    yield* drivers.authority.command({
      type: "execution.complete-task",
      request: {
        sessionId: "session",
        taskId: "root",
        actionIndex: 1,
        outcome: { status: "ok", value: "done" },
        programCapability: opened.programCapability,
      },
    });
    expect(yield* drivers.snapshot.exportSnapshot()).toEqual(
      yield* createStoredShellDrivers(store, options).snapshot.exportSnapshot(),
    );
    expect(yield* drivers.authority.query(query)).toEqual({ nested: { value: "original" } });
  });
});

it("detaches committed payloads from command inputs before retaining them", async () => {
  const store = createMemoryExecutionStore();
  await run(function* () {
    const drivers = createStoredShellDrivers(store, options);
    const input = { nested: { value: "original" } };
    const opened = yield* drivers.authority.command({
      type: "execution.open-task",
      request: { ...request, input },
    });
    input.nested.value = "mutated after commit";
    const payload = { value: "accepted emission" };
    yield* drivers.authority.command({
      type: "execution.append-emission",
      request: {
        sessionId: "session",
        taskId: "root",
        actionIndex: 0,
        descriptor: { eventType: "progress", payload },
        programCapability: opened.programCapability,
      },
    });
    payload.value = "mutated after commit";
    const retained = yield* drivers.snapshot.exportSnapshot();
    expect(retained).toEqual(
      yield* createStoredShellDrivers(store, options).snapshot.exportSnapshot(),
    );
    expect(
      yield* drivers.authority.query({ type: "task.input", sessionId: "session", taskId: "root" }),
    ).toEqual({ nested: { value: "original" } });
    expect(JSON.stringify(retained)).toContain("accepted emission");
    expect(JSON.stringify(retained)).not.toContain("mutated after commit");
  });
});
