import { describe, expect, it } from "vitest";
import {
  ANY_JSON_SCHEMA_DESCRIPTOR,
  type DurableProgramManifest,
} from "@sweatpants/durable-execution";
import type { AuthorityState, KernelContext } from "../../contract/authority-contract.ts";
import { createCapabilityKeyring } from "../../contract/capabilities.ts";
import { createDurableSchemaRegistry } from "../../contract/schema-registry.ts";
import { DecisionDraft } from "../decision-draft.ts";
import { decideAuthorityCommand } from "../authority-decisions.ts";

const manifest: DurableProgramManifest = {
  programId: "owned-draft",
  version: "1",
  digest: "a".repeat(64),
  inputSchema: ANY_JSON_SCHEMA_DESCRIPTOR,
  outputSchema: ANY_JSON_SCHEMA_DESCRIPTOR,
  elicits: {},
  effects: {},
  capabilities: { durableEmissions: true, structuredChildren: false, replay: "strict" },
};
const context: KernelContext = {
  nowMs: 1000,
  journalIdentity: { id: "journal", incarnation: "incarnation" },
  journalHeadId: "head",
  appendCursor: { sessionId: "one", nextOffset: 0 },
  schemas: createDurableSchemaRegistry(),
  keyring: createCapabilityKeyring("tests", [{ keyId: "key", secret: "x".repeat(32) }]),
};

function open(state: AuthorityState, sessionId: string, taskId: string): AuthorityState {
  return decideAuthorityCommand({
    state,
    context,
    command: {
      type: "execution.open-task",
      request: {
        sessionId,
        taskId,
        turnId: "turn",
        manifest,
        input: { text: "admitted" },
        executionEpoch: 7,
        attachmentId: "original",
        audience: "host",
      },
    },
  }).state;
}
function draft(state: AuthorityState): DecisionDraft {
  return new DecisionDraft(
    {
      state,
      context,
      command: {
        type: "control.claim-activation",
        request: { sessionId: "one", ownerId: "host" },
      },
    },
    {},
  );
}

describe("owned decision drafts", () => {
  it("read access and rejected lease claims retain the original authority identity", () => {
    const state: AuthorityState = { sessions: new Map(), nextNonce: 0 };
    const transaction = draft(state);
    expect(transaction.readSession("missing").control.runnable).toBe(false);
    expect(transaction.state).toBe(state);
    const transition = decideAuthorityCommand({
      state,
      context,
      command: {
        type: "control.claim-activation",
        request: { sessionId: "missing", ownerId: "host" },
      },
    });
    expect(transition.result).toEqual({ status: "not_runnable" });
    expect(transition.state).toBe(state);
    expect(transition.state.sessions.size).toBe(0);
  });

  it("renewing at the same authority time does not create a write", () => {
    const opened = open({ sessions: new Map(), nextNonce: 0 }, "one", "target");
    const state = decideAuthorityCommand({
      state: opened,
      context,
      command: {
        type: "control.claim-activation",
        request: { sessionId: "one", ownerId: "host" },
      },
    }).state;
    const renewal = decideAuthorityCommand({
      state,
      context,
      command: {
        type: "control.renew-activation",
        request: { sessionId: "one", ownerId: "host", epoch: 1 },
      },
    });
    expect(renewal.result.status).toBe("renewed");
    expect(renewal.state).toBe(state);
  });

  it("copies only the addressed task and session while retaining admitted program data", () => {
    let state: AuthorityState = { sessions: new Map(), nextNonce: 0 };
    state = open(state, "one", "target");
    state = open(state, "one", "sibling");
    state = open(state, "two", "unrelated");
    freezeValues(state);
    const acceptedSession = state.sessions.get("one")!;
    const acceptedTask = acceptedSession.execution.tasks.get("target")!;
    const transaction = draft(state);
    const task = transaction.task("one", "target");
    task.execution.attachmentId = "replacement";
    transaction.session("one").control.runnable = false;

    expect(transaction.task("one", "target")).toBe(task);
    expect(task.program).toBe(acceptedTask.program);
    expect(transaction.state.sessions.get("two")).toBe(state.sessions.get("two"));
    expect(transaction.state.sessions.get("one")!.execution.tasks.get("sibling")).toBe(
      acceptedSession.execution.tasks.get("sibling"),
    );
    expect(acceptedTask.execution.attachmentId).toBe("original");
    expect(acceptedSession.control.runnable).toBe(true);
  });

  it("discarding a draft preserves accepted state and a retry starts from that state", () => {
    const state = open({ sessions: new Map(), nextNonce: 0 }, "one", "target");
    const before = structuredClone(state);
    const rejected = draft(state);
    rejected.task("one", "target").lifecycle = {
      status: "active",
      cancellation: {
        type: "requested",
        commandId: "discarded",
        frontier: { actionIndex: 0 },
      },
    };
    rejected.session("one").control.lastActivationEpoch = 99;
    rejected.nonce();
    expect(() => rejected.task("one", "missing")).toThrow();

    expect(state).toEqual(before);
    const retry = draft(state);
    expect(retry.task("one", "target").lifecycle).toEqual({
      status: "active",
      cancellation: { type: "none" },
    });
    expect(retry.session("one").control.lastActivationEpoch).toBe(0);
    expect(retry.state.nextNonce).toBe(state.nextNonce);
  });

  it("activation edits every active task without changing the accepted tasks", () => {
    let state = open({ sessions: new Map(), nextNonce: 0 }, "one", "first");
    state = open(state, "one", "second");
    const transition = decideAuthorityCommand({
      state,
      context,
      command: {
        type: "control.claim-activation",
        request: { sessionId: "one", ownerId: "host" },
      },
    });
    expect(transition.result.status).toBe("claimed");
    for (const [id, task] of state.sessions.get("one")!.execution.tasks) {
      const next = transition.state.sessions.get("one")!.execution.tasks.get(id)!;
      expect(next).not.toBe(task);
      expect(task.execution.epoch).toBe(7);
      expect(next.execution.epoch).toBe(1);
    }
    expect(state.sessions.get("one")!.control.activationLease).toBeUndefined();
  });
});

// Test-only mutation tripwire: accepted records are immutable to a draft.
function freezeValues(value: unknown): void {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return;
  }
  if (value instanceof Map) {
    for (const entry of value.values()) {
      freezeValues(entry);
    }
  } else {
    for (const entry of Object.values(value)) {
      freezeValues(entry);
    }
  }
  Object.freeze(value);
}
