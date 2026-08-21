import { run, scoped } from "effection";
import { describe, expect, it } from "vitest";

import { createCapabilityKeyring } from "../capabilities.ts";
import {
  JournalAuthorityPort,
  AuthorityJournalPort,
  installInMemoryJournalAuthority,
  installStoredJournalAuthority,
} from "../authority-ports.ts";
import { installExecutionStore } from "../api.ts";
import { createMemoryExecutionStore } from "../memory.ts";
import { projectExecutionForest } from "../execution-forest.ts";
import type { DurableSemanticRecord } from "../semantic-record.ts";
import {
  ANY_JSON_SCHEMA_DESCRIPTOR,
  type DurableProgramManifest,
} from "@sweatpants/durable-execution";

const keyring = createCapabilityKeyring("kernel-tests", [
  { keyId: "test-v1", secret: "kernel-test-secret-at-least-32-bytes" },
]);
const manifest: DurableProgramManifest = {
  programId: "kernel-program",
  version: "1",
  digest: "c".repeat(64),
  inputSchema: ANY_JSON_SCHEMA_DESCRIPTOR,
  outputSchema: ANY_JSON_SCHEMA_DESCRIPTOR,
  elicits: {},
  effects: {},
  capabilities: { durableEmissions: false, structuredChildren: false, replay: "strict" },
};

describe("scoped authority boundary", () => {
  it("installs command/query and journal facades without returning a driver", async () => {
    await run(function* () {
      yield* scoped(function* () {
        expect(
          yield* installInMemoryJournalAuthority({ journalId: "boundary", keyring }),
        ).toBeUndefined();
        const authority = yield* JournalAuthorityPort.use();
        const journal = yield* AuthorityJournalPort.use();
        expect(yield* authority.query({ type: "authority.identity" })).toEqual({
          id: "boundary",
          incarnation: "1",
        });
        expect(
          yield* authority.command({
            type: "control.claim-activation",
            request: { sessionId: "missing", ownerId: "host" },
          }),
        ).toEqual({ status: "not_runnable" });
        expect(yield* journal.readSession("missing")).toEqual([]);

        const opened = yield* authority.command({
          type: "execution.open-task",
          request: {
            sessionId: "session",
            turnId: "turn-0",
            taskId: "root",
            manifest,
            input: { accepted: true },
            executionEpoch: 1,
            attachmentId: "attachment",
            audience: "program-runtime",
          },
        });
        expect(opened.programCapability).toEqual(expect.any(String));
        const input = yield* authority.query({
          type: "task.input",
          sessionId: "session",
          taskId: "root",
        });
        (input as { accepted: boolean }).accepted = false;
        expect(
          yield* authority.query({ type: "task.input", sessionId: "session", taskId: "root" }),
        ).toEqual({ accepted: true });
        const cancellation = yield* authority.query({
          type: "task.cancellation-state",
          sessionId: "session",
          taskId: "root",
        });
        (cancellation as { type: string }).type = "unwinding";
        expect(
          yield* authority.query({
            type: "task.cancellation-state",
            sessionId: "session",
            taskId: "root",
          }),
        ).toEqual({ type: "none" });
        expect((yield* journal.readSession("session")).map((entry) => entry.payload.type)).toEqual([
          "TaskOpened",
        ]);
      });
    });
  });

  it("runs the same command boundary through the stored installer", async () => {
    await run(function* () {
      yield* installExecutionStore(createMemoryExecutionStore());
      yield* installStoredJournalAuthority({ journalId: "stored-boundary", keyring });
      const authority = yield* JournalAuthorityPort.use();
      const journal = yield* AuthorityJournalPort.use();
      yield* authority.command({
        type: "execution.open-task",
        request: {
          sessionId: "stored-session",
          turnId: "turn-0",
          taskId: "root",
          manifest,
          input: null,
          executionEpoch: 1,
          attachmentId: "attachment",
          audience: "program-runtime",
        },
      });
      expect(
        yield* authority.query({ type: "task.input", sessionId: "stored-session", taskId: "root" }),
      ).toBeNull();
      expect(
        (yield* journal.readSession("stored-session")).map((entry) => entry.payload.type),
      ).toEqual(["TaskOpened"]);
    });
  });

  it("composes the complete private stack in canonical order", async () => {
    const trace: string[] = [];
    await run(function* () {
      yield* installInMemoryJournalAuthority({
        journalId: "diagnostics",
        keyring,
        decisionDiagnostics(diagnostic) {
          trace.push(`${diagnostic.phase}:${diagnostic.stage}`);
        },
      });
      const authority = yield* JournalAuthorityPort.use();
      yield* authority.command({
        type: "execution.open-task",
        request: {
          sessionId: "session",
          turnId: "turn-0",
          taskId: "root",
          manifest,
          input: null,
          executionEpoch: 1,
          attachmentId: "attachment",
          audience: "program-runtime",
        },
      });
    });
    expect(trace).toEqual([
      "enter:decision-diagnostics",
      "enter:semantic-consistency",
      "enter:structural-validation",
      "enter:common-idempotency",
      "enter:exhaustive-dispatcher",
      "complete:exhaustive-dispatcher",
      "complete:common-idempotency",
      "complete:structural-validation",
      "complete:semantic-consistency",
      "complete:decision-diagnostics",
    ]);
  });

  it("rejects a second shell driver in the same scope", async () => {
    await run(function* () {
      yield* installInMemoryJournalAuthority({ journalId: "first", keyring });
      let failure: unknown;
      try {
        yield* installInMemoryJournalAuthority({ journalId: "second", keyring });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeDefined();
    });
  });
});

describe("execution forest", () => {
  it("projects mixed actions and a child under the exact invocation pull", () => {
    const records: DurableSemanticRecord[] = [
      record("0", {
        type: "TaskOpened",
        taskId: "root",
        turnId: "turn-0",
        programId: "root-program",
        programVersion: "1",
        programDigest: "a".repeat(64),
        input: { prompt: "go" },
        inputDigest: "input",
      }),
      record("1", {
        type: "DurableEmission",
        taskId: "root",
        actionIndex: 0,
        emissionIndex: 0,
        descriptor: { eventType: "progress", payload: { value: 1 } },
        descriptorDigest: "emission",
      }),
      record("2", {
        type: "PullRequested",
        taskId: "root",
        turnId: "turn-0",
        actionIndex: 1,
        pullIndex: 0,
        pullId: "invoke",
        descriptor: {
          kind: "invoke",
          child: { id: "child-program", version: "1", digest: "b".repeat(64), input: null },
        },
        descriptorDigest: "invoke-digest",
      }),
      record("3", {
        type: "TaskOpened",
        taskId: "child",
        turnId: "turn-0",
        programId: "child-program",
        programVersion: "1",
        programDigest: "b".repeat(64),
        input: null,
        inputDigest: "child-input",
        parentTaskId: "root",
        parentPullId: "invoke",
      }),
      record("4", {
        type: "TaskClosed",
        taskId: "child",
        outcome: { status: "ok", value: { done: true } },
      }),
      record("5", {
        type: "PullResolved",
        taskId: "root",
        pullId: "invoke",
        outcome: { status: "ok", value: { done: true } },
        outcomeDigest: "outcome",
      }),
    ];

    const forest = projectExecutionForest(records);
    expect(forest.roots).toHaveLength(1);
    expect(forest.roots[0]?.actions.map((action) => action.kind)).toEqual(["emission", "pull"]);
    const pull = forest.roots[0]?.actions[1];
    expect(pull?.kind).toBe("pull");
    if (pull?.kind === "pull") {
      expect(pull.children.map((child) => child.taskId)).toEqual(["child"]);
      expect(pull.settlement?.offset).toBe("5");
    }
  });

  it("rejects a partial child origin", () => {
    expect(() =>
      projectExecutionForest([
        record("0", {
          type: "TaskOpened",
          taskId: "child",
          turnId: "turn-0",
          programId: "child-program",
          programVersion: "1",
          programDigest: "b".repeat(64),
          input: null,
          inputDigest: "child-input",
          parentTaskId: "root",
        }),
      ]),
    ).toThrowError(expect.objectContaining({ code: "invalid_journal" }));
  });
});

function record(offset: string, payload: DurableSemanticRecord["payload"]): DurableSemanticRecord {
  return {
    offset,
    eventId: `journal:session:${offset}`,
    sessionId: "session",
    payload,
  };
}
