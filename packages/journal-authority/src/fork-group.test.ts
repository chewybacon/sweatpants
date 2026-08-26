import { describe, expect, it } from "vitest";
import type { OperationOutcome } from "@sweatpants/durable-effects";
import { CrankError } from "@sweatpants/durable-execution";

import {
  assertForkPolicyPairing,
  beginForkGroupCancellation,
  drainForkGroup,
  forceOrphanForkGroupResolution,
  forkGroupKey,
  forkGroupOutcome,
  reduceForkMemberTerminal,
  resolveForkDeadline,
  type ForkGroupState,
  type ForkPolicy,
} from "./fork-group.ts";

const ok = (value: string): OperationOutcome => ({ status: "ok", value });
const err = (code: string): OperationOutcome => ({
  status: "error",
  error: { code, message: code },
});
const cancelled = (): OperationOutcome => ({ status: "cancelled" });

const ALL: ForkPolicy = { mode: "all", supervision: "one_for_all" };
const RACE: ForkPolicy = { mode: "race", supervision: "first_success" };

function makeGroup(policy: ForkPolicy, memberCount = 2): ForkGroupState {
  return {
    groupId: "g1",
    parentTaskId: "p",
    pullId: "pull-0",
    descriptorDigest: "d".repeat(16),
    policy,
    deadlineMs: 10_000,
    members: Array.from({ length: memberCount }, (_, ordinal) => ({
      ordinal,
      taskId: `p.${ordinal}`,
    })),
    status: "open",
  };
}

function syncCode(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error instanceof CrankError ? error.code : String(error);
  }
}

describe("resolveForkDeadline (TC-017)", () => {
  it("resolves absolute deadlines", () => {
    expect(resolveForkDeadline({ kind: "at", atMs: 5_000 }, undefined, 1_000)).toBe(5_000);
    expect(resolveForkDeadline({ kind: "after", durationMs: 500 }, undefined, 1_000)).toBe(1_500);
  });

  it("fails closed on malformed, expired, or unresolvable policies", () => {
    expect(syncCode(() => resolveForkDeadline({ kind: "at", atMs: Number.NaN }, undefined, 1_000))).toBe("invalid_descriptor");
    expect(syncCode(() => resolveForkDeadline({ kind: "at", atMs: 500 }, undefined, 1_000))).toBe("fork_expiry_unresolvable");
    expect(syncCode(() => resolveForkDeadline({ kind: "after", durationMs: -1 }, undefined, 1_000))).toBe("invalid_descriptor");
    expect(syncCode(() => resolveForkDeadline({ kind: "inherit" }, undefined, 1_000))).toBe("fork_expiry_unresolvable");
  });

  it("inherits through ancestors and never exceeds the ancestor cap", () => {
    expect(resolveForkDeadline({ kind: "inherit" }, 8_000, 1_000)).toBe(8_000);
    expect(resolveForkDeadline({ kind: "at", atMs: 9_000 }, 8_000, 1_000)).toBe(8_000);
    expect(resolveForkDeadline({ kind: "after", durationMs: 60_000 }, 8_000, 1_000)).toBe(8_000);
  });
});

describe("assertForkPolicyPairing (REQ-025)", () => {
  it("accepts the closed pairings and rejects mismatches", () => {
    expect(syncCode(() => assertForkPolicyPairing(ALL))).toBeUndefined();
    expect(syncCode(() => assertForkPolicyPairing(RACE))).toBeUndefined();
    expect(syncCode(() => assertForkPolicyPairing({ mode: "all", supervision: "first_success" }))).toBe("invalid_descriptor");
    expect(syncCode(() => assertForkPolicyPairing({ mode: "race", supervision: "one_for_all" }))).toBe("invalid_descriptor");
    expect(syncCode(() => assertForkPolicyPairing({ mode: "spray", supervision: "none" }))).toBe("invalid_descriptor");
  });
});

describe("reduceForkMemberTerminal (TC-020)", () => {
  it("all: resolves completed with outcomes in descriptor order", () => {
    const group = makeGroup(ALL, 2);
    expect(reduceForkMemberTerminal(group, "p.1", ok("B")).resolution).toBeUndefined();
    const reduction = reduceForkMemberTerminal(group, "p.0", ok("A"));
    expect(reduction.resolution).toMatchObject({
      status: "completed",
      outcomes: [
        { ordinal: 0, outcome: { status: "ok", value: "A" } },
        { ordinal: 1, outcome: { status: "ok", value: "B" } },
      ],
    });
  });

  it("all: first failure starts one-for-all cancellation and fails after drain", () => {
    const group = makeGroup(ALL, 3);
    const first = reduceForkMemberTerminal(group, "p.0", err("boom"));
    expect(group.status).toBe("cancelling");
    expect(first.cancelMembers).toEqual(["p.1", "p.2"]);
    expect(first.resolution).toBeUndefined();
    reduceForkMemberTerminal(group, "p.1", cancelled());
    const drained = reduceForkMemberTerminal(group, "p.2", cancelled());
    expect(drained.resolution).toMatchObject({
      status: "failed",
      error: { code: "boom" },
    });
  });

  it("race: first committed success wins; losers cancel; winner leads the biography", () => {
    const group = makeGroup(RACE, 2);
    const winner = reduceForkMemberTerminal(group, "p.0", ok("fast"));
    expect(winner.winnerSelected).toEqual({
      ordinal: 0,
      outcomeDigest: expect.any(String),
    });
    expect(winner.cancelMembers).toEqual(["p.1"]);
    expect(winner.resolution).toBeUndefined();
    const drained = reduceForkMemberTerminal(group, "p.1", cancelled());
    expect(drained.resolution).toMatchObject({
      status: "completed",
      winnerOrdinal: 0,
      outcomes: [{ ordinal: 0, outcome: { status: "ok", value: "fast" } }, { ordinal: 1 }],
    });
  });

  it("race: all-member failure fails after the last terminal member", () => {
    const group = makeGroup(RACE, 2);
    expect(reduceForkMemberTerminal(group, "p.0", err("a")).resolution).toBeUndefined();
    expect(group.status).toBe("open");
    const drained = reduceForkMemberTerminal(group, "p.1", err("b"));
    expect(drained.resolution).toMatchObject({
      status: "failed",
      error: { code: "fork_group_failed" },
    });
  });

  it("member cancellation resolves the group cancelled", () => {
    const group = makeGroup(ALL, 2);
    reduceForkMemberTerminal(group, "p.0", cancelled());
    const drained = reduceForkMemberTerminal(group, "p.1", cancelled());
    expect(drained.resolution).toMatchObject({ status: "cancelled" });
  });

  it("expiry cause resolves expired only once every member is terminal", () => {
    const group = makeGroup(ALL, 2);
    const members = beginForkGroupCancellation(group, "expiry");
    expect(members).toEqual(["p.0", "p.1"]);
    reduceForkMemberTerminal(group, "p.0", cancelled());
    expect(drainForkGroup(group)).toBeUndefined();
    reduceForkMemberTerminal(group, "p.1", cancelled());
    expect(drainForkGroup(group)).toMatchObject({ status: "expired" });
  });

  it("breach-first precedence: late success is confined to member history", () => {
    const group = makeGroup(RACE, 2);
    beginForkGroupCancellation(group, "expiry");
    // A late success arrives after the breach: no winner is selected.
    const late = reduceForkMemberTerminal(group, "p.0", ok("too-late"));
    expect(late.winnerSelected).toBeUndefined();
    reduceForkMemberTerminal(group, "p.1", cancelled());
    expect(drainForkGroup(group)).toMatchObject({ status: "expired" });
    expect(group.resolution).toMatchObject({ status: "expired" });
  });

  it("rejects a second differing terminal for the same member", () => {
    const group = makeGroup(ALL, 2);
    reduceForkMemberTerminal(group, "p.0", ok("A"));
    expect(reduceForkMemberTerminal(group, "p.0", ok("A")).resolution).toBeUndefined();
    expect(syncCode(() => reduceForkMemberTerminal(group, "p.0", ok("different")))).toBe("nondeterminism_detected");
  });

  it("confines late biographies after an orphaned resolution", () => {
    const group = makeGroup(ALL, 2);
    reduceForkMemberTerminal(group, "p.0", cancelled());
    const resolution = forceOrphanForkGroupResolution(group, "cleanup_stuck");
    expect(resolution).toMatchObject({ status: "orphaned" });
    const late = reduceForkMemberTerminal(group, "p.1", cancelled());
    expect(late.resolution).toBeUndefined();
    expect(group.resolution).toMatchObject({ status: "orphaned" });
    expect(syncCode(() => forceOrphanForkGroupResolution(group, "again"))).toBe("fork_group_terminal");
  });
});

describe("forkGroupKey (TC-022)", () => {
  it("is stable for the composite identity and distinct when any field changes", () => {
    const base = forkGroupKey("p", "pull-0", "digest");
    expect(forkGroupKey("p", "pull-0", "digest")).toBe(base);
    expect(forkGroupKey("p", "pull-1", "digest")).not.toBe(base);
    expect(forkGroupKey("q", "pull-0", "digest")).not.toBe(base);
    expect(forkGroupKey("p", "pull-0", "other")).not.toBe(base);
  });
});

describe("forkGroupOutcome", () => {
  it("maps the five endings onto the outcome transport with the Terminal inside", () => {
    expect(
      forkGroupOutcome({ status: "completed", outcomes: [] }),
    ).toMatchObject({ status: "ok" });
    expect(
      forkGroupOutcome({
        status: "failed",
        error: { code: "x", message: "x" },
        outcomes: [],
      }),
    ).toMatchObject({ status: "error", error: { code: "x" } });
    expect(forkGroupOutcome({ status: "cancelled", outcomes: [] })).toMatchObject({
      status: "cancelled",
    });
    expect(forkGroupOutcome({ status: "expired", outcomes: [] })).toMatchObject({
      status: "error",
      error: { code: "fork_group_expired" },
    });
    expect(forkGroupOutcome({ status: "orphaned", reason: "r" })).toMatchObject({
      status: "error",
      error: { code: "fork_group_orphaned" },
    });
  });
});
