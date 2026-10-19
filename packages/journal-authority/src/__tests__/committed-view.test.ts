import { ANY_JSON_SCHEMA_DESCRIPTOR } from "@sweatpants/durable-execution";
import { createSignal, run, spawn, suspend } from "effection";
import type { Json } from "@sweatpants/foundation";
import { expect, it } from "vitest";
import { createCapabilityKeyring } from "../contract/capabilities.ts";
import { createJournal } from "../shell/journal.ts";
import { createInMemoryJournal } from "../shell/in-memory-journal.ts";
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
  await run(function* () {
    const peer = yield* createJournal(store, options);
    let complete: AuthorityCommand;
    let attempts = 0;
    let objectReads = 0;
    let journalReads = 0;
    const measured: ExecutionStore = {
      ...store,
      *commitExecution(proposal) {
        if (attempts++ === 0) {
          yield* peer.advance(complete);
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

    const opened = yield* peer.advance({ type: "execution.open-task", request });
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
    const drivers = yield* createJournal(measured, options);
    yield* drivers.advance(complete);
    expect(attempts).toBe(1);
    expect(objectReads).toBe(2);
    expect(journalReads).toBe(2);
    const accepted = yield* drivers.exportSnapshot();
    expect(objectReads).toBe(2);
    expect(journalReads).toBe(2);
    const cold = yield* createJournal(store, options);
    expect(accepted).toEqual(yield* cold.exportSnapshot());
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
    const drivers = yield* createJournal(measured, options);
    const opened = yield* drivers.advance({ type: "execution.open-task", request });
    const before = yield* drivers.exportSnapshot();
    reject = true;
    let error: unknown;
    try {
      yield* drivers.advance({
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
    expect(yield* drivers.exportSnapshot()).toEqual(before);
    const restoredJournal1 = yield* createJournal(store, options);
    expect(yield* restoredJournal1.exportSnapshot()).toEqual(before);
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
  for (let depth = 0; depth < 140; depth++) {
    input = { nested: input };
  }
  await run(function* () {
    const drivers = yield* createJournal(measured, options);
    let error: unknown;
    try {
      yield* drivers.advance({
        type: "execution.open-task",
        request: { ...request, input },
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: "invalid_descriptor" });
    expect(writes).toBe(0);
    expect(yield* store.loadControl("authority:committed-view")).toBeNull();
    const restoredJournal2 = yield* createJournal(store, options);
    expect(yield* drivers.exportSnapshot()).toEqual(yield* restoredJournal2.exportSnapshot());
    const opened = yield* drivers.advance({ type: "execution.open-task", request });
    const before = yield* drivers.exportSnapshot();
    writes = 0;
    error = undefined;
    try {
      yield* drivers.advance({
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
    expect(yield* drivers.exportSnapshot()).toEqual(before);
    const restoredJournal3 = yield* createJournal(store, options);
    expect(yield* restoredJournal3.exportSnapshot()).toEqual(before);
  });
});

it("isolates warm query results and observes a peer mutation before the next command", async () => {
  const store = createMemoryExecutionStore();
  await run(function* () {
    const drivers = yield* createJournal(store, options);
    const peer = yield* createJournal(store, options);
    const opened = yield* drivers.advance({
      type: "execution.open-task",
      request: { ...request, input: { nested: { value: "original" } } },
    });
    const query = { type: "task.input", sessionId: "session", taskId: "root" } as const;
    const input = yield* drivers.query(query);
    expect(input).toEqual({ nested: { value: "original" } });
    Reflect.set(input as object, "nested", { value: "changed by reader" });
    expect(yield* drivers.query(query)).toEqual({ nested: { value: "original" } });
    yield* peer.advance({
      type: "execution.append-emission",
      request: {
        sessionId: "session",
        taskId: "root",
        actionIndex: 0,
        descriptor: { eventType: "progress", payload: "peer" },
        programCapability: opened.programCapability,
      },
    });
    yield* drivers.advance({
      type: "execution.complete-task",
      request: {
        sessionId: "session",
        taskId: "root",
        actionIndex: 1,
        outcome: { status: "ok", value: "done" },
        programCapability: opened.programCapability,
      },
    });
    const restoredJournal4 = yield* createJournal(store, options);
    expect(yield* drivers.exportSnapshot()).toEqual(yield* restoredJournal4.exportSnapshot());
    expect(yield* drivers.query(query)).toEqual({ nested: { value: "original" } });
  });
});

it("detaches committed payloads from command inputs before retaining them", async () => {
  const store = createMemoryExecutionStore();
  await run(function* () {
    const drivers = yield* createJournal(store, options);
    const input = { nested: { value: "original" } };
    const opened = yield* drivers.advance({
      type: "execution.open-task",
      request: { ...request, input },
    });
    input.nested.value = "mutated after commit";
    const payload = { value: "accepted emission" };
    yield* drivers.advance({
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
    const retained = yield* drivers.exportSnapshot();
    const restoredJournal5 = yield* createJournal(store, options);
    expect(retained).toEqual(yield* restoredJournal5.exportSnapshot());
    expect(
      yield* drivers.query({ type: "task.input", sessionId: "session", taskId: "root" }),
    ).toEqual({ nested: { value: "original" } });
    expect(JSON.stringify(retained)).toContain("accepted emission");
    expect(JSON.stringify(retained)).not.toContain("mutated after commit");
  });
});

it("reloads durable truth when persistence succeeded but acknowledgment failed", async () => {
  const store = createMemoryExecutionStore();
  let loseAcknowledgment = false;
  let objectReads = 0;
  const measured: ExecutionStore = {
    ...store,
    *commitExecution(proposal) {
      const committed = yield* store.commitExecution(proposal);
      if (loseAcknowledgment) {
        throw new Error("acknowledgment lost");
      }
      return committed;
    },
    *getObject(pointer) {
      objectReads++;
      return yield* store.getObject(pointer);
    },
  };
  await run(function* () {
    const drivers = yield* createJournal(measured, options);
    const opened = yield* drivers.advance({ type: "execution.open-task", request });
    loseAcknowledgment = true;
    let caught: unknown;
    try {
      yield* drivers.advance({
        type: "execution.append-emission",
        request: {
          sessionId: "session",
          taskId: "root",
          actionIndex: 0,
          descriptor: { eventType: "progress", payload: "persisted without acknowledgment" },
          programCapability: opened.programCapability,
        },
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ message: "acknowledgment lost" });
    expect(objectReads).toBe(0);
    loseAcknowledgment = false;
    const restored = yield* drivers.exportSnapshot();
    // The failed operation did not promote its draft: the next read restores
    // the newly committed revision from storage rather than reusing that draft.
    expect(objectReads).toBe(1);
    const restoredJournal6 = yield* createJournal(store, options);
    expect(restored).toEqual(yield* restoredJournal6.exportSnapshot());
    expect(JSON.stringify(restored)).toContain("persisted without acknowledgment");
    yield* drivers.advance({
      type: "execution.complete-task",
      request: {
        sessionId: "session",
        taskId: "root",
        actionIndex: 1,
        outcome: { status: "ok", value: "done" },
        programCapability: opened.programCapability,
      },
    });
    expect(objectReads).toBe(1);
  });
});

it("does not promote a persisted draft when its caller is halted before acknowledgment", async () => {
  const store = createMemoryExecutionStore();
  const persisted = createSignal<void>();
  let pauseAcknowledgment = false;
  let objectReads = 0;
  let returned = false;
  let canceled = false;
  const measured: ExecutionStore = {
    ...store,
    *commitExecution(proposal) {
      const committed = yield* store.commitExecution(proposal);
      if (pauseAcknowledgment) {
        persisted.send();
        yield* suspend();
      }
      return committed;
    },
    *getObject(pointer) {
      objectReads++;
      return yield* store.getObject(pointer);
    },
  };
  await run(function* () {
    const drivers = yield* createJournal(measured, options);
    const opened = yield* drivers.advance({ type: "execution.open-task", request });
    const writes = yield* persisted;
    pauseAcknowledgment = true;
    const caller = yield* spawn(function* () {
      try {
        yield* drivers.advance({
          type: "execution.append-emission",
          request: {
            sessionId: "session",
            taskId: "root",
            actionIndex: 0,
            descriptor: { eventType: "progress", payload: "persisted before halt" },
            programCapability: opened.programCapability,
          },
        });
        returned = true;
      } finally {
        canceled = true;
      }
    });
    yield* writes.next();
    yield* caller.halt();
    expect(canceled).toBe(true);
    expect(returned).toBe(false);
    expect(objectReads).toBe(0);
    pauseAcknowledgment = false;
    const restored = yield* drivers.exportSnapshot();
    expect(objectReads).toBe(1);
    const restoredJournal7 = yield* createJournal(store, options);
    expect(restored).toEqual(yield* restoredJournal7.exportSnapshot());
    expect(JSON.stringify(restored)).toContain("persisted before halt");
  });
});

it.each(["memory", "stored"])(
  "%s journal owns descriptors and preserves replay identity",
  async (kind) => {
    await run(function* () {
      const store = createMemoryExecutionStore();
      const journal =
        kind === "stored"
          ? yield* createJournal(store, options)
          : yield* createInMemoryJournal(options);
      const opened = yield* journal.advance({
        type: "execution.open-task",
        request: {
          ...request,
          manifest: {
            ...request.manifest,
            elicits: { card: { response: ANY_JSON_SCHEMA_DESCRIPTOR } },
          },
        },
      });
      const payload = { value: "accepted" };
      const emission = {
        sessionId: "session",
        taskId: "root",
        actionIndex: 0,
        descriptor: { eventType: "progress", payload },
        programCapability: opened.programCapability,
      };
      const receipt = yield* journal.advance({
        type: "execution.append-emission",
        request: emission,
      });
      payload.value = "changed";
      const duplicate = yield* journal.advance({
        type: "execution.append-emission",
        request: {
          ...emission,
          descriptor: { eventType: "progress", payload: { value: "accepted" } },
        },
      });
      expect(duplicate).toEqual({ ...receipt, duplicate: true });
      const descriptor = {
        kind: "elicit" as const,
        key: "card",
        message: "Choose",
        response: ANY_JSON_SCHEMA_DESCRIPTOR,
        binding: undefined,
      };
      const reservation = {
        sessionId: "session",
        taskId: "root",
        turnId: "turn",
        actionIndex: 1,
        pullIndex: 0,
        descriptor,
        programCapability: opened.programCapability,
      };
      const reserved = yield* journal.advance({
        type: "execution.reserve-pull",
        request: reservation,
      });
      expect(reserved.status).toBe("pending");
      if (reserved.status !== "pending") {
        throw new Error("expected a parked elicitation");
      }
      descriptor.message = "changed";
      const query = {
        type: "pull.state" as const,
        sessionId: "session",
        taskId: "root",
        pullId: reserved.pullId,
      };
      const observed = yield* journal.query(query);
      expect(observed.status).toBe("found");
      if (observed.status !== "found") {
        throw new Error("expected the accepted descriptor");
      }
      expect(observed.descriptor).toMatchObject({ message: "Choose" });
      Object.assign(observed.descriptor, { message: "changed through query" });
      expect(yield* journal.query(query)).toMatchObject({ descriptor: { message: "Choose" } });
      const { binding: _binding, ...withoutBinding } = { ...descriptor, message: "Choose" };
      expect(
        yield* journal.advance({
          type: "execution.reserve-pull",
          request: { ...reservation, descriptor: withoutBinding },
        }),
      ).toEqual(reserved);
      const snapshot = yield* journal.exportSnapshot();
      const restored =
        kind === "stored"
          ? yield* createJournal(store, options)
          : yield* createInMemoryJournal({ ...options, snapshot });
      expect(yield* restored.query(query)).toMatchObject({ descriptor: { message: "Choose" } });
      expect(JSON.stringify(yield* restored.readSession("session"))).toContain(
        '"value":"accepted"',
      );
      expect(JSON.stringify(yield* restored.readSession("session"))).not.toContain("changed");
    });
  },
);

it.each(["memory", "stored"])(
  "%s journal owns terminal errors without policing absent details",
  async (kind) => {
    await run(function* () {
      const store = createMemoryExecutionStore();
      const journal =
        kind === "stored"
          ? yield* createJournal(store, options)
          : yield* createInMemoryJournal(options);
      const opened = yield* journal.advance({ type: "execution.open-task", request });
      const error = { code: "failed", message: "Original failure", details: undefined };
      const completion = {
        sessionId: "session",
        taskId: "root",
        actionIndex: 0,
        outcome: { status: "error" as const, error },
        programCapability: opened.programCapability,
      };
      const completed = yield* journal.advance({
        type: "execution.complete-task",
        request: completion,
      });
      expect(completed.status).toBe("accepted");
      error.message = "changed";
      const duplicate = yield* journal.advance({
        type: "execution.complete-task",
        request: {
          ...completion,
          outcome: { status: "error", error: { code: "failed", message: "Original failure" } },
        },
      });
      expect(duplicate.status).toBe("duplicate");
      const snapshot = yield* journal.exportSnapshot();
      const restored =
        kind === "stored"
          ? yield* createJournal(store, options)
          : yield* createInMemoryJournal({ ...options, snapshot });
      const records = yield* restored.readSession("session");
      expect(records.at(-1)?.payload).toMatchObject({
        type: "TaskClosed",
        outcome: { status: "error", error: { code: "failed", message: "Original failure" } },
      });
    });
  },
);
