import { run } from "effection";
import { describe, expect, it } from "vitest";

import {
  ANY_JSON_SCHEMA_DESCRIPTOR,
  createCapabilityKeyring,
  createInMemoryDurableJournalAuthority,
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
      yield* value.requestCancellation("s1", "task");
      clock = 41_000;
      const takeover = yield* value.claimActivation({ sessionId: "s1", ownerId: "b" });
      expect(takeover).toMatchObject({ status: "claimed", epoch: 2 });
      expect(yield* value.renewActivation({ sessionId: "s1", ownerId: "a", epoch: 1 })).toEqual({
        status: "stale_activation",
      });
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
      expect(
        yield* value.consumeRestoreTicket({
          sessionId: "s2",
          taskId: "task",
          ownerId: "owner",
          activationEpoch: 1,
          proof: { restoreTicket: issued.restoreTicket, frontierDigest: "c".repeat(64) },
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
