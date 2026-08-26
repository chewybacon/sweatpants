import { run, type Operation } from "effection";
import { describe, expect, it } from "vitest";

import { createCapabilityKeyring } from "../index.ts";
import { createAuthorityScenarioDriver } from "../testing.ts";
import { ANY_JSON_SCHEMA_DESCRIPTOR, type DurableProgramManifest } from "@sweatpants/durable-execution";

const parentManifest: DurableProgramManifest = {
  programId: "fixture.parent",
  version: "1",
  digest: "a".repeat(64),
  inputSchema: ANY_JSON_SCHEMA_DESCRIPTOR,
  outputSchema: ANY_JSON_SCHEMA_DESCRIPTOR,
  elicits: {},
  effects: {},
  capabilities: { durableEmissions: true, structuredChildren: true, replay: "strict" },
};

function childManifest(id: string, digestChar: string): DurableProgramManifest {
  return {
    programId: id,
    version: "1",
    digest: digestChar.repeat(64),
    inputSchema: ANY_JSON_SCHEMA_DESCRIPTOR,
    outputSchema: ANY_JSON_SCHEMA_DESCRIPTOR,
    elicits: {},
    effects: {},
    capabilities: { durableEmissions: true, structuredChildren: true, replay: "strict" },
  };
}

const childA = { id: "fixture.child-a", version: "1", digest: "b".repeat(64), input: { n: 1 } };
const childB = { id: "fixture.child-b", version: "1", digest: "c".repeat(64), input: { n: 2 } };

function authority(now: () => number) {
  return createAuthorityScenarioDriver({
    journalId: "journal",
    journalIncarnation: "incarnation",
    keyring: createCapabilityKeyring("tests", [{ keyId: "k1", secret: "x".repeat(32) }]),
    now,
  });
}

function* codeOf(operation: () => Operation<unknown>): Operation<string | undefined> {
  try {
    yield* operation();
    return undefined;
  } catch (error) {
    return error instanceof Error && "code" in error ? String(error.code) : String(error);
  }
}

describe("fork groups: admission and freeze (REQ-021, REQ-023, REQ-030)", () => {
  it("opens all members atomically, dedupes retries, and freezes the parent", async () => {
    const clock = () => 1_000;
    const value = authority(clock);
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
        expiryPolicy: { kind: "at", atMs: 100_000 },
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
          children: [childA, childB],
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
          { child: childA, manifest: childManifest(childA.id, "b") },
          { child: childB, manifest: childManifest(childB.id, "c") },
        ],
        executionEpoch: 1,
        audience: "workflow-host",
      });
      expect(group).toEqual({
        status: "opened",
        groupId: "task/" + reserved.pullId + "/group",
        deadlineMs: 51_000,
        memberTaskIds: ["task.0", "task.1"],
      });

      // Identical retry commits once (REQ-023).
      const retry = yield* value.openForkGroup({
        sessionId: "s1",
        turnId: "t1",
        parentTaskId: "task",
        parentPullId: reserved.pullId,
        members: [
          { child: childA, manifest: childManifest(childA.id, "b") },
          { child: childB, manifest: childManifest(childB.id, "c") },
        ],
        executionEpoch: 1,
        audience: "workflow-host",
      });
      expect(retry.status).toBe("duplicate");
      expect(retry.memberTaskIds).toEqual(["task.0", "task.1"]);

      // Freeze (REQ-021): new work on the parent is refused while the group is
      // open; replay re-reserve of the recorded pull stays legal.
      const replayed = yield* value.reserve({
        sessionId: "s1",
        turnId: "t1",
        taskId: "task",
        actionIndex: 0,
        pullIndex: 0,
        descriptor: {
          kind: "all",
          supervision: "one_for_all",
          children: [childA, childB],
          expiry: { kind: "after", durationMs: 50_000 },
        },
        programCapability: opened.programCapability,
      });
      expect(replayed.status).toBe("pending");
      expect(
        yield* codeOf(() =>
          value.reserve({
              sessionId: "s1",
              turnId: "t1",
              taskId: "task",
              actionIndex: 1,
              pullIndex: 1,
              descriptor: { kind: "wait", key: "later", durationMs: 1_000 },
              programCapability: opened.programCapability,
            }),
        ),
      ).toBe("fork_group_open");

      // Fork evidence is journaled.
      const journal = value.readJournal("s1");
      const openedRecord = journal.find((record) => record.payload.type === "ForkGroupOpened");
      expect(openedRecord?.payload).toMatchObject({
        type: "ForkGroupOpened",
        taskId: "task",
        policy: { mode: "all", supervision: "one_for_all" },
        deadlineMs: 51_000,
        memberTaskIds: ["task.0", "task.1"],
      });
      expect(
        journal.filter((record) => record.payload.type === "ForkGroupOpened"),
      ).toHaveLength(1);
    });
  });

  it("fails admission closed on unresolvable or expired policies", async () => {
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
        // No root expiry policy: inherit has nowhere to resolve from.
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
          children: [childA],
          expiry: { kind: "inherit" },
        },
        programCapability: opened.programCapability,
      });
      if (reserved.status !== "pending") throw new Error("fork pull did not park");
      expect(
        yield* codeOf(() =>
          value.openForkGroup({
            sessionId: "s1",
            turnId: "t1",
            parentTaskId: "task",
            parentPullId: reserved.pullId,
            members: [{ child: childA, manifest: childManifest(childA.id, "b") }],
            executionEpoch: 1,
            audience: "workflow-host",
          }),
        ),
      ).toBe("fork_expiry_unresolvable");
      // No member rows exist after the failed admission.
      expect(value.exportSnapshot().sessions[0]?.[1].execution.tasks).toHaveLength(1);
    });
  });
});

describe("fork groups: terminal algebra (REQ-026)", () => {
  async function openAllGroup(clock: () => number) {
    const value = authority(clock);
    const result = await run(function* () {
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
          children: [childA, childB],
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
          { child: childA, manifest: childManifest(childA.id, "b") },
          { child: childB, manifest: childManifest(childB.id, "c") },
        ],
        executionEpoch: 1,
        audience: "workflow-host",
      });
      return { pullId: reserved.pullId, group };
    });
    return { value, ...result };
  }

  it("resolves the parent slot once with biographies in descriptor order", async () => {
    const { value, pullId } = await openAllGroup(() => 1_000);
    await run(function* () {
      // Either completion order resolves the same value.
      yield* value.complete({
        sessionId: "s1",
        taskId: "task.1",
        actionIndex: 0,
        outcome: { status: "ok", value: "B" },
        programCapability: value.programCapability("s1", "task.1"),
      });
      let state = yield* value.operationState("s1", "task", pullId);
      expect(state).toMatchObject({ status: "found" });
      expect("outcome" in state && state.outcome !== undefined).toBe(false);

      yield* value.complete({
        sessionId: "s1",
        taskId: "task.0",
        actionIndex: 0,
        outcome: { status: "ok", value: "A" },
        programCapability: value.programCapability("s1", "task.0"),
      });
      state = yield* value.operationState("s1", "task", pullId);
      expect(state).toMatchObject({
        status: "found",
        outcome: {
          status: "ok",
          value: {
            status: "completed",
            outcomes: [
              { ordinal: 0, taskId: "task.0", outcome: { status: "ok", value: "A" } },
              { ordinal: 1, taskId: "task.1", outcome: { status: "ok", value: "B" } },
            ],
          },
        },
      });
      const resolutions = value
        .readJournal("s1")
        .filter((record) => record.payload.type === "ForkGroupResolved");
      expect(resolutions).toHaveLength(1);
    });
  });

  it("one-for-all: first failure cancels the sibling and fails after drain", async () => {
    const { value, pullId } = await openAllGroup(() => 1_000);
    await run(function* () {
      yield* value.complete({
        sessionId: "s1",
        taskId: "task.0",
        actionIndex: 0,
        outcome: { status: "error", error: { code: "boom", message: "boom" } },
        programCapability: value.programCapability("s1", "task.0"),
      });
      // Sibling cancellation was requested before any group resolution.
      expect(
        value
          .readJournal("s1")
          .filter((record) => record.payload.type === "CancellationRequested")
          .map((record) => record.payload),
      ).toMatchObject([{ type: "CancellationRequested", taskId: "task.1" }]);
      expect(
        value.readJournal("s1").filter((r) => r.payload.type === "ForkGroupResolved"),
      ).toHaveLength(0);

      yield* value.complete({
        sessionId: "s1",
        taskId: "task.1",
        actionIndex: 0,
        outcome: { status: "cancelled" },
        programCapability: value.programCapability("s1", "task.1"),
      });
      const state = yield* value.operationState("s1", "task", pullId);
      expect(state).toMatchObject({
        status: "found",
        outcome: { status: "error", error: { code: "boom" } },
      });
    });
  });
});

describe("fork groups: race precedence (REQ-026, REQ-032)", () => {
  async function openRaceGroup(clock: () => number) {
    const value = authority(clock);
    const result = await run(function* () {
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
          kind: "race",
          supervision: "first_success",
          children: [childA, childB],
          expiry: { kind: "at", atMs: 60_000 },
        },
        programCapability: opened.programCapability,
      });
      if (reserved.status !== "pending") throw new Error("race pull did not park");
      const group = yield* value.openForkGroup({
        sessionId: "s1",
        turnId: "t1",
        parentTaskId: "task",
        parentPullId: reserved.pullId,
        members: [
          { child: childA, manifest: childManifest(childA.id, "b") },
          { child: childB, manifest: childManifest(childB.id, "c") },
        ],
        executionEpoch: 1,
        audience: "workflow-host",
      });
      return { pullId: reserved.pullId, group };
    });
    return { value, ...result };
  }

  it("selects the first committed winner and resolves after losers drain", async () => {
    const { value, pullId, group } = await openRaceGroup(() => 1_000);
    await run(function* () {
      yield* value.complete({
        sessionId: "s1",
        taskId: "task.0",
        actionIndex: 0,
        outcome: { status: "ok", value: "fast" },
        programCapability: value.programCapability("s1", "task.0"),
      });
      const journal = value.readJournal("s1");
      expect(
        journal.find((record) => record.payload.type === "RaceWinnerSelected")?.payload,
      ).toMatchObject({ type: "RaceWinnerSelected", winnerTaskId: "task.0" });
      // Loser cancellation precedes resolution.
      expect(
        journal.find((record) => record.payload.type === "CancellationRequested")?.payload,
      ).toMatchObject({ taskId: "task.1" });

      yield* value.complete({
        sessionId: "s1",
        taskId: "task.1",
        actionIndex: 0,
        outcome: { status: "cancelled" },
        programCapability: value.programCapability("s1", "task.1"),
      });
      const state = yield* value.operationState("s1", "task", pullId);
      expect(state).toMatchObject({
        status: "found",
        outcome: {
          status: "ok",
          value: { status: "completed", winnerOrdinal: 0 },
        },
      });

      // Breach after resolution is a typed rejection (first commit won).
      expect(
        yield* codeOf(() =>
          value.breachForkGroup({ sessionId: "s1", taskId: "task", groupId: group.groupId }),
        ),
      ).toBe("fork_group_terminal");
    });
  });

  it("breach first: late success is confined and the group resolves expired", async () => {
    let clock = 1_000;
    const { value, pullId, group } = await openRaceGroup(() => clock);
    await run(function* () {
      // Too early: no breach before the deadline.
      expect(
        yield* codeOf(() =>
          value.breachForkGroup({ sessionId: "s1", taskId: "task", groupId: group.groupId }),
        ),
      ).toBe("fork_group_unexpired");

      clock = 61_000;
      const breach = yield* value.breachForkGroup({
        sessionId: "s1",
        taskId: "task",
        groupId: group.groupId,
      });
      expect(breach.cancelMembers).toEqual(["task.0", "task.1"]);

      // Late success after the breach selects no winner.
      yield* value.complete({
        sessionId: "s1",
        taskId: "task.0",
        actionIndex: 0,
        outcome: { status: "ok", value: "too-late" },
        programCapability: value.programCapability("s1", "task.0"),
      });
      expect(
        value.readJournal("s1").filter((r) => r.payload.type === "RaceWinnerSelected"),
      ).toHaveLength(0);

      yield* value.complete({
        sessionId: "s1",
        taskId: "task.1",
        actionIndex: 0,
        outcome: { status: "cancelled" },
        programCapability: value.programCapability("s1", "task.1"),
      });
      const state = yield* value.operationState("s1", "task", pullId);
      expect(state).toMatchObject({
        status: "found",
        outcome: { status: "error", error: { code: "fork_group_expired" } },
      });

      // Breach record precedes every cancellation offset (REQ-031).
      const journal = value.readJournal("s1");
      const breachOffset = Number(
        journal.find((r) => r.payload.type === "ForkGroupBreached")!.offset,
      );
      for (const record of journal.filter((r) => r.payload.type === "CancellationRequested")) {
        expect(Number(record.offset)).toBeGreaterThan(breachOffset);
      }
    });
  });
});

describe("fork groups: snapshot restart (REQ-071)", () => {
  it("restores a mid-group forest from the snapshot and resolves identically", async () => {
    const keyring = createCapabilityKeyring("tests", [{ keyId: "k1", secret: "x".repeat(32) }]);
    const options = { journalId: "journal", journalIncarnation: "incarnation", keyring };
    const value = createAuthorityScenarioDriver({ ...options, now: () => 1_000 });
    const { snapshot, pullId } = await run(function* () {
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
          children: [childA, childB],
          expiry: { kind: "after", durationMs: 50_000 },
        },
        programCapability: opened.programCapability,
      });
      if (reserved.status !== "pending") throw new Error("fork pull did not park");
      yield* value.openForkGroup({
        sessionId: "s1",
        turnId: "t1",
        parentTaskId: "task",
        parentPullId: reserved.pullId,
        members: [
          { child: childA, manifest: childManifest(childA.id, "b") },
          { child: childB, manifest: childManifest(childB.id, "c") },
        ],
        executionEpoch: 1,
        audience: "workflow-host",
      });
      // Crash point: one member terminal, group unresolved.
      yield* value.complete({
        sessionId: "s1",
        taskId: "task.0",
        actionIndex: 0,
        outcome: { status: "ok", value: "A" },
        programCapability: value.programCapability("s1", "task.0"),
      });
      return { snapshot: value.exportSnapshot(), pullId: reserved.pullId };
    });

    const restored = createAuthorityScenarioDriver({ ...options, now: () => 1_000, snapshot });
    await run(function* () {
      // Idempotent replay of the recorded member terminal.
      yield* restored.complete({
        sessionId: "s1",
        taskId: "task.0",
        actionIndex: 0,
        outcome: { status: "ok", value: "A" },
        programCapability: restored.programCapability("s1", "task.0"),
      });
      yield* restored.complete({
        sessionId: "s1",
        taskId: "task.1",
        actionIndex: 0,
        outcome: { status: "ok", value: "B" },
        programCapability: restored.programCapability("s1", "task.1"),
      });
      const state = yield* restored.operationState("s1", "task", pullId);
      expect(state).toMatchObject({
        status: "found",
        outcome: {
          status: "ok",
          value: {
            status: "completed",
            outcomes: [
              { ordinal: 0, outcome: { status: "ok", value: "A" } },
              { ordinal: 1, outcome: { status: "ok", value: "B" } },
            ],
          },
        },
      });
      expect(
        restored.readJournal("s1").filter((r) => r.payload.type === "ForkGroupResolved"),
      ).toHaveLength(1);
    });
  });
});

describe("fork groups: force orphan (REQ-034)", () => {
  it("records orphaned honestly and settles the parent with the Terminal value", async () => {
    let clock = 1_000;
    const value = authority(() => clock);
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
      const reserved = yield* value.reserve({
        sessionId: "s1",
        turnId: "t1",
        taskId: "task",
        actionIndex: 0,
        pullIndex: 0,
        descriptor: {
          kind: "all",
          supervision: "one_for_all",
          children: [childA, childB],
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
          { child: childA, manifest: childManifest(childA.id, "b") },
          { child: childB, manifest: childManifest(childB.id, "c") },
        ],
        executionEpoch: 1,
        audience: "workflow-host",
      });

      // Force-orphan requires a stuck cancelling group.
      expect(
        yield* codeOf(() =>
          value.forceOrphanForkGroup({
              sessionId: "s1",
              taskId: "task",
              groupId: group.groupId,
              reason: "stuck",
            }),
        ),
      ).toBe("fork_group_not_cancelling");

      clock = 51_000;
      yield* value.breachForkGroup({ sessionId: "s1", taskId: "task", groupId: group.groupId });
      // Cleanup cannot terminate (no member close arrives): force-orphan.
      const orphan = yield* value.forceOrphanForkGroup({
        sessionId: "s1",
        taskId: "task",
        groupId: group.groupId,
        reason: "cleanup_stuck",
      });
      expect(orphan.resolution).toEqual({ status: "orphaned", reason: "cleanup_stuck" });

      const state = yield* value.operationState("s1", "task", reserved.pullId);
      expect(state).toMatchObject({
        status: "found",
        outcome: { status: "error", error: { code: "fork_group_orphaned" } },
      });
      // Members were orphaned in place, not fabricated as cancelled.
      expect(
        value
          .readJournal("s1")
          .filter((r) => r.payload.type === "TaskOrphaned")
          .map((r) => r.payload),
      ).toMatchObject([
        { type: "TaskOrphaned", taskId: "task.0", reason: "cleanup_stuck" },
        { type: "TaskOrphaned", taskId: "task.1", reason: "cleanup_stuck" },
      ]);
      // The orphan authorization is single-shot.
      expect(
        yield* codeOf(() =>
          value.forceOrphanForkGroup({
              sessionId: "s1",
              taskId: "task",
              groupId: group.groupId,
              reason: "again",
            }),
        ),
      ).toBe("fork_group_terminal");
    });
  });
});
