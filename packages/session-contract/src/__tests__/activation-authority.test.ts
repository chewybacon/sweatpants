import { run } from "effection";
import { describe, expect, it } from "vitest";

import {
  ANY_JSON_SCHEMA_DESCRIPTOR,
  createCapabilityKeyring,
  canonicalJson,
  createInMemoryDurableJournalAuthority,
  sha256,
  type DurableProgramManifest,
} from "../index.ts";

const manifest: DurableProgramManifest = {
  programId: "fixture.activation",
  version: "1",
  digest: "a".repeat(64),
  inputSchema: ANY_JSON_SCHEMA_DESCRIPTOR,
  outputSchema: ANY_JSON_SCHEMA_DESCRIPTOR,
  elicits: {},
  effects: {},
  capabilities: { durableEmissions: true, structuredChildren: false, replay: "strict" },
};

function authority(now: () => number) {
  return createInMemoryDurableJournalAuthority({
    journalId: "journal",
    journalIncarnation: "incarnation",
    keyring: createCapabilityKeyring("tests", [{ keyId: "k1", secret: "x".repeat(32) }]),
    now,
  });
}

describe("activation leases and restore fencing", () => {
  it("claims runnable work once, renews by owner, and takes over exactly at expiry", async () => {
    let clock = 1_000;
    const value = authority(() => clock);
    await run(function* () {
      yield* value.openTask({
        sessionId: "s1",
        turnId: "t1",
        taskId: "task",
        manifest,
        input: {},
        executionEpoch: 1,
        attachmentId: "initial",
        audience: "program-runtime",
      });
      const claim = yield* value.claimActivation({ sessionId: "s1", ownerId: "a" });
      expect(claim).toMatchObject({ status: "claimed", epoch: 1, expiresAtMs: 31_000 });
      expect(yield* value.claimActivation({ sessionId: "s1", ownerId: "b" })).toEqual({
        status: "busy",
        retryAfterMs: 30_000,
      });
      clock = 11_000;
      expect(yield* value.renewActivation({ sessionId: "s1", ownerId: "wrong", epoch: 1 })).toEqual(
        { status: "stale_activation" },
      );
      expect(yield* value.renewActivation({ sessionId: "s1", ownerId: "a", epoch: 1 })).toEqual({
        status: "renewed",
        expiresAtMs: 41_000,
      });
      clock = 12_000;
      expect(yield* value.renewActivation({ sessionId: "s1", ownerId: "a", epoch: 1 })).toEqual({
        status: "renewed",
        expiresAtMs: 42_000,
      });
      yield* value.requestCancellation("s1", "task");
      clock = 42_000;
      const takeover = yield* value.claimActivation({ sessionId: "s1", ownerId: "b" });
      expect(takeover).toMatchObject({ status: "claimed", epoch: 2 });
      expect(yield* value.renewActivation({ sessionId: "s1", ownerId: "a", epoch: 1 })).toEqual({
        status: "stale_activation",
      });
    });
  });

  it("recovers an expired in-flight lease even though claim cleared runnable", async () => {
    let clock = 1_000;
    const value = authority(() => clock);
    await run(function* () {
      yield* value.openTask({
        sessionId: "crashed",
        turnId: "turn",
        taskId: "task",
        manifest,
        input: {},
        executionEpoch: 1,
        attachmentId: "initial",
        audience: "program-runtime",
      });
      expect(
        yield* value.claimActivation({
          sessionId: "crashed",
          ownerId: "dead",
          leaseDurationMs: 1_000,
        }),
      ).toMatchObject({ status: "claimed" });
      expect(yield* value.recoverableSessions()).toEqual([]);
      clock = 2_000;
      expect(yield* value.recoverableSessions()).toEqual([
        { sessionId: "crashed", reason: "expired_activation" },
      ]);
      expect(
        yield* value.claimActivation({ sessionId: "crashed", ownerId: "replacement" }),
      ).toMatchObject({ status: "claimed", epoch: 2 });
    });
  });

  it("binds the verified frontier digest to the exact first semantic transition", async () => {
    const value = authority(() => 2_000);
    await run(function* () {
      const opened = yield* value.openTask({
        sessionId: "s-frontier",
        turnId: "t-frontier",
        taskId: "task",
        manifest,
        input: {},
        executionEpoch: 1,
        attachmentId: "initial",
        audience: "program-runtime",
      });
      expect(
        yield* value.claimActivation({ sessionId: "s-frontier", ownerId: "owner" }),
      ).toMatchObject({ status: "claimed", epoch: 1 });
      const prepared = yield* value.prepareProgramRestore({
        sessionId: "s-frontier",
        taskId: "task",
        ownerId: "owner",
        activationEpoch: 1,
        releaseId: "release",
        sandboxSessionId: "sandbox",
      });
      expect(prepared.replay).toEqual([]);
      expect(prepared.replayedThroughActionIndex).toBe(-1);
      const frontier = {
        type: "emission" as const,
        actionIndex: 0,
        descriptor: { eventType: "ready", payload: { value: true } },
      };
      const frontierDigest = sha256(
        canonicalJson({
          domain: "sweatpants.agentcore.frontier.v1",
          protocolVersion: 1,
          releaseId: "release",
          taskId: "task",
          activationEpoch: 1,
          replayedThroughActionIndex: -1,
          replayChainDigest: prepared.replayChainDigest,
          step: frontier,
        }),
      );
      const bound = yield* value.bindRestoreFrontier({
        sessionId: "s-frontier",
        taskId: "task",
        ownerId: "owner",
        activationEpoch: 1,
        restoreTicket: prepared.restoreTicket,
        frontierDigest,
      });
      if (bound.status !== "bound") throw new Error("frontier was not bound");
      let errorCode: string | undefined;
      try {
        yield* value.emit({
          sessionId: "s-frontier",
          taskId: "task",
          actionIndex: 0,
          descriptor: frontier.descriptor,
          programCapability: opened.programCapability,
          restoredFrontier: bound.proof,
          restoredFrontierStep: {
            ...frontier,
            descriptor: { eventType: "different", payload: { value: true } },
          },
        });
      } catch (error) {
        errorCode =
          error && typeof error === "object" && "code" in error ? String(error.code) : undefined;
      }
      expect(errorCode).toBe("restore_stale");
    });
  });

  it("uses single-use head-bound restore tickets and applies contention backoff", async () => {
    let clock = 5_000;
    const value = authority(() => clock);
    await run(function* () {
      yield* value.openTask({
        sessionId: "s2",
        turnId: "t2",
        taskId: "task",
        manifest,
        input: {},
        executionEpoch: 1,
        attachmentId: "initial",
        audience: "program-runtime",
      });
      expect(yield* value.claimActivation({ sessionId: "s2", ownerId: "owner" })).toMatchObject({
        status: "claimed",
        epoch: 1,
      });
      const issued = yield* value.issueRestoreTicket({
        sessionId: "s2",
        taskId: "task",
        ownerId: "owner",
        activationEpoch: 1,
        replayedThroughActionIndex: 0,
        replayChainDigest: "b".repeat(64),
      });
      const bound = yield* value.bindRestoreFrontier({
        sessionId: "s2",
        taskId: "task",
        ownerId: "owner",
        activationEpoch: 1,
        restoreTicket: issued.restoreTicket,
        frontierDigest: "c".repeat(64),
      });
      expect(bound.status).toBe("bound");
      if (bound.status !== "bound") throw new Error("frontier was not bound");
      expect(
        yield* value.consumeRestoreTicket({
          sessionId: "s2",
          taskId: "task",
          ownerId: "owner",
          activationEpoch: 1,
          proof: bound.proof,
        }),
      ).toEqual({ status: "consumed" });
      for (let count = 1; count <= 3; count += 1) {
        const stale = yield* value.consumeRestoreTicket({
          sessionId: "s2",
          taskId: "task",
          ownerId: "owner",
          activationEpoch: 1,
          proof: { restoreTicket: issued.restoreTicket, frontierDigest: "c".repeat(64) },
        });
        expect(stale).toMatchObject({ status: "restore_stale", consecutiveStales: count });
        if (count === 3) expect(stale).toMatchObject({ releaseRequired: true, retryAfterMs: 250 });
      }
      expect(yield* value.claimActivation({ sessionId: "s2", ownerId: "other" })).toEqual({
        status: "busy",
        retryAfterMs: 250,
      });
      clock += 250;
      expect(yield* value.claimActivation({ sessionId: "s2", ownerId: "other" })).toMatchObject({
        status: "claimed",
        epoch: 2,
      });
    });
  });
});
