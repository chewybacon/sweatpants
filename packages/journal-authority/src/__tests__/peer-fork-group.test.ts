import { run } from "effection";
import { describe, expect, it } from "vitest";

import type { OperationOutcome } from "@sweatpants/durable-effects";
import { createCapabilityKeyring } from "../index.ts";
import {
  createAuthorityScenarioDriver,
  createPeerSimulator,
  PeerTransportError,
} from "../testing.ts";
import {
  ANY_JSON_SCHEMA_DESCRIPTOR,
  type DurableChildDescriptor,
  type DurableProgramManifest,
} from "@sweatpants/durable-execution";

const parentManifest: DurableProgramManifest = {
  programId: "fixture.peer-parent",
  version: "1",
  digest: "a".repeat(64),
  inputSchema: ANY_JSON_SCHEMA_DESCRIPTOR,
  outputSchema: ANY_JSON_SCHEMA_DESCRIPTOR,
  elicits: {},
  effects: {},
  capabilities: { durableEmissions: true, structuredChildren: true, replay: "strict" },
};

function memberManifest(id: string, digestChar: string): DurableProgramManifest {
  return {
    programId: id,
    version: "1",
    digest: digestChar.repeat(64),
    inputSchema: ANY_JSON_SCHEMA_DESCRIPTOR,
    outputSchema: ANY_JSON_SCHEMA_DESCRIPTOR,
    elicits: {},
    effects: {},
    capabilities: { durableEmissions: true, structuredChildren: false, replay: "strict" },
  };
}

const localChild: DurableChildDescriptor = {
  id: "fixture.peer-local",
  version: "1",
  digest: "b".repeat(64),
  input: "local",
};

const peerChild: DurableChildDescriptor = {
  id: "fixture.peer-remote",
  version: "1",
  digest: "c".repeat(64),
  input: "remote",
  durability: { kind: "peer_hosted", peer: "peer-1", sampling: "delegated" },
};

function authority(now: () => number) {
  return createAuthorityScenarioDriver({
    journalId: "journal",
    journalIncarnation: "incarnation",
    keyring: createCapabilityKeyring("tests", [{ keyId: "k1", secret: "x".repeat(32) }]),
    now,
  });
}

function* openMixedGroup(value: ReturnType<typeof authority>) {
  const opened = yield* value.openTask({
    sessionId: "s1",
    turnId: "t1",
    taskId: "task",
    manifest: parentManifest,
    input: {},
    executionEpoch: 1,
    attachmentId: "initial",
    audience: "workflow-host",
  });
  const reserved = yield* value.reserve({
    sessionId: "s1",
    turnId: "t1",
    taskId: "task",
    actionIndex: 0,
    pullIndex: 0,
    descriptor: {
      kind: "all",
      supervision: "one_for_all",
      children: [localChild, peerChild],
      expiry: { kind: "after", durationMs: 50_000 },
    },
    programCapability: opened.programCapability,
  });
  if (reserved.status !== "pending") throw new Error("fork pull did not park");
  const group = yield* value.openForkGroup({
    sessionId: "s1",
    turnId: "t1",
    parentTaskId: "task",
    parentPullId: reserved.pullId,
    members: [
      { child: localChild, manifest: memberManifest(localChild.id, "b") },
      { child: peerChild, manifest: memberManifest(peerChild.id, "c") },
    ],
    executionEpoch: 1,
    audience: "workflow-host",
  });
  return { opened, reserved, group };
}

describe("peer members: classification and admission (REQ-035, REQ-042)", () => {
  it("stores the closed durability class and derives peer audiences locally", async () => {
    const value = authority(() => 1_000);
    await run(function* () {
      yield* openMixedGroup(value);
      const snapshot = value.exportSnapshot();
      const tasks = snapshot.sessions[0]![1].execution.tasks;
      const peerMember = tasks.find((task) => task.taskId === "task.1");
      expect(peerMember?.execution.audience).toBe("peer:peer-1");
      const groupRow = tasks.find((task) => task.taskId === "task")?.forkGroup;
      expect(groupRow?.members[1]).toMatchObject({
        durability: "peer_hosted",
        peer: "peer-1",
        sampling: "delegated",
      });
    });
  });

  it("rejects a peer member without a sampling declaration at admission", async () => {
    const value = authority(() => 1_000);
    await run(function* () {
      const opened = yield* value.openTask({
        sessionId: "s1",
        turnId: "t1",
        taskId: "task",
        manifest: parentManifest,
        input: {},
        executionEpoch: 1,
        attachmentId: "initial",
        audience: "workflow-host",
      });
      const undeclared = {
        ...peerChild,
        durability: { kind: "peer_hosted", peer: "peer-1" },
      } as unknown as DurableChildDescriptor;
      const reserved = yield* value.reserve({
        sessionId: "s1",
        turnId: "t1",
        taskId: "task",
        actionIndex: 0,
        pullIndex: 0,
        descriptor: {
          kind: "all",
          supervision: "one_for_all",
          children: [undeclared],
          expiry: { kind: "after", durationMs: 50_000 },
        },
        programCapability: opened.programCapability,
      });
      if (reserved.status !== "pending") throw new Error("fork pull did not park");
      let code: string | undefined;
      try {
        yield* value.openForkGroup({
          sessionId: "s1",
          turnId: "t1",
          parentTaskId: "task",
          parentPullId: reserved.pullId,
          members: [{ child: undeclared, manifest: memberManifest(peerChild.id, "c") }],
          executionEpoch: 1,
          audience: "workflow-host",
        });
      } catch (error) {
        code = error instanceof Error && "code" in error ? String(error.code) : String(error);
      }
      expect(code).toBe("invalid_descriptor");
      // Admission failed before any member row opened.
      expect(value.exportSnapshot().sessions[0]?.[1].execution.tasks).toHaveLength(1);
    });
  });
});

describe("peer delivery: journal-first, correlators, mandates (REQ-038, REQ-040, REQ-074)", () => {
  it("commits before send, dedupes by correlator, and never serializes capabilities", async () => {
    const value = authority(() => 1_000);
    const simulator = createPeerSimulator();
    await run(function* () {
      const { group } = yield* openMixedGroup(value);

      const delegation = yield* value.commitPeerDelegation({
        sessionId: "s1",
        taskId: "task",
        groupId: group.groupId,
        memberTaskId: "task.1",
      });
      expect(delegation.status).toBe("committed");
      // Journal-first: the record exists before any send.
      expect(
        value.readJournal("s1").filter((r) => r.payload.type === "PeerDelegationCommitted"),
      ).toHaveLength(1);
      expect(simulator.server.deliveries).toHaveLength(0);

      const delivery = {
        correlator: delegation.correlator,
        groupId: group.groupId,
        memberTaskId: "task.1",
        program: { id: peerChild.id, version: peerChild.version, digest: peerChild.digest },
        input: peerChild.input,
        deadlineMs: group.deadlineMs,
      };
      // REQ-040: the wire vocabulary carries no capability material.
      expect(Object.keys(delivery).sort()).toEqual([
        "correlator",
        "deadlineMs",
        "groupId",
        "input",
        "memberTaskId",
        "program",
      ]);
      const ack = yield* simulator.transport.deliver(delivery);
      expect(ack).toEqual({ correlator: delegation.correlator, duplicate: false });

      // Retry reuses the correlator; the server dedupes (REQ-039).
      const retry = yield* simulator.transport.deliver(delivery);
      expect(retry.duplicate).toBe(true);
      expect(simulator.server.deliveries).toHaveLength(2);
      expect(simulator.server.deliveries[1]).toEqual(simulator.server.deliveries[0]);

      // Delegation retry is idempotent and keeps the correlator stable.
      const again = yield* value.commitPeerDelegation({
        sessionId: "s1",
        taskId: "task",
        groupId: group.groupId,
        memberTaskId: "task.1",
      });
      expect(again).toMatchObject({ status: "duplicate", correlator: delegation.correlator });
      expect(
        value.readJournal("s1").filter((r) => r.payload.type === "PeerDelegationCommitted"),
      ).toHaveLength(1);

      // The DeliveryMandate proves itself; evidence for another member fails.
      let code: string | undefined;
      try {
        yield* value.commitPeerEvidence({
          sessionId: "s1",
          taskId: "task",
          groupId: group.groupId,
          memberTaskId: "task.0", // crank-native member: no peer path
          correlator: delegation.correlator,
          outcome: { status: "ok", value: "wrong" },
          deliveryMandate: delegation.deliveryMandate,
        });
      } catch (error) {
        code = error instanceof Error && "code" in error ? String(error.code) : String(error);
      }
      expect(code).toBe("invalid_descriptor");
    });
  });
});

describe("peer evidence and loss (REQ-026, REQ-032, REQ-043)", () => {
  it("commits peer evidence through the reducer and resolves the group", async () => {
    const value = authority(() => 1_000);
    const simulator = createPeerSimulator();
    await run(function* () {
      const { reserved, group } = yield* openMixedGroup(value);
      const delegation = yield* value.commitPeerDelegation({
        sessionId: "s1",
        taskId: "task",
        groupId: group.groupId,
        memberTaskId: "task.1",
      });
      yield* simulator.transport.deliver({
        correlator: delegation.correlator,
        groupId: group.groupId,
        memberTaskId: "task.1",
        program: { id: peerChild.id, version: peerChild.version, digest: peerChild.digest },
        input: peerChild.input,
        deadlineMs: group.deadlineMs,
      });

      // Local member completes first; group stays open on the peer.
      yield* value.complete({
        sessionId: "s1",
        taskId: "task.0",
        actionIndex: 0,
        outcome: { status: "ok", value: "L" },
        programCapability: value.programCapability("s1", "task.0"),
      });
      let state = yield* value.operationState("s1", "task", reserved.pullId);
      expect("outcome" in state && state.outcome !== undefined).toBe(false);

      // Peer evidence arrives and commits under the mandate.
      simulator.server.emitEvidence({
        correlator: delegation.correlator,
        outcome: { status: "ok", value: "P" },
      });
      const frame = yield* simulator.transport.nextEvidence();
      if (frame === null) throw new Error("peer died unexpectedly");
      yield* value.commitPeerEvidence({
        sessionId: "s1",
        taskId: "task",
        groupId: group.groupId,
        memberTaskId: "task.1",
        correlator: frame.correlator,
        outcome: frame.outcome,
        deliveryMandate: delegation.deliveryMandate,
      });

      state = yield* value.operationState("s1", "task", reserved.pullId);
      expect(state).toMatchObject({
        status: "found",
        outcome: {
          status: "ok",
          value: {
            status: "completed",
            outcomes: [
              { ordinal: 0, outcome: { status: "ok", value: "L" } },
              { ordinal: 1, outcome: { status: "ok", value: "P" } },
            ],
          },
        },
      });

      // Late duplicate evidence is a typed rejection, never a rewrite.
      let code: string | undefined;
      try {
        yield* value.commitPeerEvidence({
          sessionId: "s1",
          taskId: "task",
          groupId: group.groupId,
          memberTaskId: "task.1",
          correlator: delegation.correlator,
          outcome: { status: "ok", value: "P-again" },
          deliveryMandate: delegation.deliveryMandate,
        });
      } catch (error) {
        code = error instanceof Error && "code" in error ? String(error.code) : String(error);
      }
      expect(code).toBe("fork_member_terminal");
    });
  });

  it("types peer loss and flows it through one-for-all supervision", async () => {
    const value = authority(() => 1_000);
    const simulator = createPeerSimulator();
    await run(function* () {
      const { reserved, group } = yield* openMixedGroup(value);
      const delegation = yield* value.commitPeerDelegation({
        sessionId: "s1",
        taskId: "task",
        groupId: group.groupId,
        memberTaskId: "task.1",
      });

      simulator.server.kill();
      let lost: unknown;
      try {
        yield* simulator.transport.deliver({
          correlator: delegation.correlator,
          groupId: group.groupId,
          memberTaskId: "task.1",
          program: { id: peerChild.id, version: peerChild.version, digest: peerChild.digest },
          input: peerChild.input,
          deadlineMs: group.deadlineMs,
        });
      } catch (error) {
        lost = error;
      }
      expect(lost).toBeInstanceOf(PeerTransportError);

      yield* value.reportPeerLoss({
        sessionId: "s1",
        taskId: "task",
        groupId: group.groupId,
        memberTaskId: "task.1",
        correlator: delegation.correlator,
        reason: "peer-1 unreachable",
        deliveryMandate: delegation.deliveryMandate,
      });

      // one_for_all: the sibling is cancelled before the group fails.
      expect(
        value
          .readJournal("s1")
          .filter((r) => r.payload.type === "CancellationRequested")
          .map((r) => r.payload),
      ).toMatchObject([{ type: "CancellationRequested", taskId: "task.0" }]);
      yield* value.complete({
        sessionId: "s1",
        taskId: "task.0",
        actionIndex: 0,
        outcome: { status: "cancelled" },
        programCapability: value.programCapability("s1", "task.0"),
      });

      const state = yield* value.operationState("s1", "task", reserved.pullId);
      expect(state).toMatchObject({
        status: "found",
        outcome: {
          status: "error",
          error: {
            code: "peer_lost",
            details: {
              status: "failed",
              outcomes: [
                { ordinal: 0, outcome: { status: "cancelled" } },
                { ordinal: 1, outcome: { status: "error", error: { code: "peer_lost" } } },
              ],
            },
          },
        },
      });
    });
  });
});
