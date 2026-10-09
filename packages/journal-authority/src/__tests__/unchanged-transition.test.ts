import { run } from "effection";
import type { DurableAuthoritySnapshot } from "../state/authority-snapshot.ts";
import { expect, it } from "vitest";
import { authorityStateFromSnapshot, projectAuthoritySnapshot } from "../state/authority-state.ts";
import { validateAuthorityMutation } from "../store/snapshot-codec.ts";
import { MAX_SNAPSHOT_TASKS } from "../store/durable-authority-snapshot-schema.ts";
import { ANY_JSON_SCHEMA_DESCRIPTOR } from "@sweatpants/durable-execution";
import { createJournal } from "../shell/journal.ts";
import { createMemoryExecutionStore } from "../store/memory.ts";
import { createCapabilityKeyring } from "../contract/capabilities.ts";

const options = {
  journalId: "unchanged-transitions",
  keyring: createCapabilityKeyring("test", [{ keyId: "key", secret: "x".repeat(32) }]),
};
const request = {
  sessionId: "session",
  taskId: "root",
  turnId: "turn",
  manifest: {
    programId: "unchanged",
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
  audience: "host",
};

it("does not create durable state for a missing session's refused activation", async () => {
  const store = createMemoryExecutionStore();
  await run(function* () {
    const journal = yield* createJournal(store, options);
    expect(
      yield* journal.advance({
        type: "control.claim-activation",
        request: { sessionId: "missing", ownerId: "host" },
      }),
    ).toEqual({ status: "not_runnable" });
    expect(yield* store.loadControl(`authority:${options.journalId}`)).toBeNull();
    expect((yield* journal.exportSnapshot()).sessions).toEqual([]);
  });
});

it("replays a parked pull and rejects a response without staging any writes", async () => {
  const store = createMemoryExecutionStore();
  await run(function* () {
    const journal = yield* createJournal(store, options);
    const opened = yield* journal.advance({ type: "execution.open-task", request });
    const reserve = {
      type: "execution.reserve-pull" as const,
      request: {
        sessionId: "session",
        taskId: "root",
        turnId: "turn",
        actionIndex: 0,
        pullIndex: 0,
        descriptor: {
          kind: "elicit" as const,
          key: "card",
          message: "Pick a card",
          response: ANY_JSON_SCHEMA_DESCRIPTOR,
        },
        programCapability: opened.programCapability,
      },
    };
    const pending = yield* journal.advance(reserve);
    if (pending.status !== "pending" || !pending.resolutionCapability) {
      throw new Error("Expected an elicitation");
    }
    const control = yield* store.loadControl(`authority:${options.journalId}`);
    const snapshot = yield* journal.exportSnapshot();
    // No-op decisions must not reach staging, even if another read or inspection
    // would hide an unnecessary control revision increment.
    const strict = yield* createJournal(
      {
        ...store,
        *putObject() {
          throw new Error("Unexpected object write");
        },
        *commitExecution() {
          throw new Error("Unexpected commit");
        },
      },
      options,
    );
    expect(yield* strict.advance(reserve)).toEqual(pending);
    expect(
      yield* strict.advance({
        type: "execution.resolve-pull",
        request: {
          capability: pending.resolutionCapability,
          audience: "user:card",
          outcome: { status: "ok", value: "not an elicitation envelope" },
        },
      }),
    ).toMatchObject({ status: "rejected", code: "schema_validation_failed" });
    expect(yield* strict.exportSnapshot()).toEqual(snapshot);
    expect(yield* store.loadControl(`authority:${options.journalId}`)).toEqual(control);
  });
});

it("admits only owned task edits while preserving whole-snapshot limits", async () => {
  await run(function* () {
    const journal = yield* createJournal(createMemoryExecutionStore(), options);
    yield* journal.advance({ type: "execution.open-task", request });
    const previous = authorityStateFromSnapshot(yield* journal.exportSnapshot());
    const snapshot = projectAuthoritySnapshot(previous);
    const session = snapshot.sessions[0]![1];
    const retained = session.execution.tasks[0]!;
    const edited = { ...retained, taskId: "second" };
    const candidate: DurableAuthoritySnapshot = {
      ...snapshot,
      sessions: [["session", { ...session, execution: { tasks: [retained, edited] } }]],
    };
    expect(() => validateAuthorityMutation(previous, candidate)).not.toThrow();
    const input = retained.program.input;
    Object.defineProperty(retained.program, "input", {
      configurable: true,
      get() {
        throw new Error("Retained payload traversed");
      },
    });
    try {
      const leaseOnly: DurableAuthoritySnapshot = {
        ...snapshot,
        sessions: [
          [
            "session",
            {
              ...session,
              execution: {
                tasks: [{ ...retained, execution: { ...retained.execution, epoch: 2 } }],
              },
            },
          ],
        ],
      };
      expect(() => validateAuthorityMutation(previous, leaseOnly)).not.toThrow();
    } finally {
      Object.defineProperty(retained.program, "input", {
        value: input,
        writable: true,
        configurable: true,
      });
    }
    const malformed = structuredClone(candidate);
    Reflect.set(malformed.sessions[0][1].execution.tasks[1]!, "nextActionIndex", -1);
    expect(() => validateAuthorityMutation(previous, malformed)).toThrow(
      "Invalid durable authority snapshot",
    );
    const oversized: DurableAuthoritySnapshot = {
      ...snapshot,
      sessions: [
        [
          "session",
          {
            ...session,
            execution: { tasks: Array.from({ length: MAX_SNAPSHOT_TASKS + 1 }, () => retained) },
          },
        ],
      ],
    };
    expect(() => validateAuthorityMutation(previous, oversized)).toThrow(
      "Invalid durable authority snapshot",
    );
    const excessiveDepth = structuredClone(candidate);
    let nested: object = {};
    for (let depth = 0; depth < 130; depth++) {
      nested = { nested };
    }
    Reflect.set(excessiveDepth.sessions[0][1].execution.tasks[1]!.program, "input", nested);
    expect(() => validateAuthorityMutation(previous, excessiveDepth)).toThrow(
      "Invalid durable authority snapshot",
    );
  });
});
