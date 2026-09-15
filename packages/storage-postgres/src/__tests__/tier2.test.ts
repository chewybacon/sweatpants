/**
 * Tier-2 conformance: concurrency semantics that exercise the Postgres
 * locking model directly. Tier-1 (single-threaded conformance) runs in the
 * shared store suites; these cases prove that contention resolves into
 * deterministic outcomes — one winner per revision, one claim holder, and
 * never a lost update.
 */
import { run } from "effection";
import { describe, expect, it } from "vitest";
import {
  DurableCollections,
  durableKey,
  type DurableKernel,
  type DurableMutationOutcome,
} from "@sweatpants/durable-storage-kernel";
import {
  encodeCommandReceipt,
  encodeConversationHead,
  type CommandReceipt,
  type ConversationHead,
} from "@sweatpants/history-store/persistence";
import { openPostgresStorageForTest } from "../pg-binding.ts";

const connectionString =
  process.env.SWEATPANTS_DATABASE_URL ??
  "postgres://postgres:postgres@127.0.0.1:55432/sweatpants_test";

const WORKERS = 8;
const COMMITS_PER_WORKER = 25;

function headValue(conversationId: string, revision: number): Uint8Array {
  const head: ConversationHead = {
    conversationId,
    revision: String(revision),
    ownerEpoch: "0",
    ownerRoute: null,
    state: "idle",
    checkpoint: null,
    terminalHistory: null,
    activeLogicalTurnId: null,
    activeExecutionId: null,
    latestCompletedExecutionId: null,
    activeSegment: null,
    activeCommand: null,
    deletedAt: null,
    updatedAt: 1,
  };
  return encodeConversationHead(head);
}

function receiptValue(
  conversationId: string,
  commandId: string,
): { digest: string; value: Uint8Array } {
  const receipt: CommandReceipt = {
    conversationId,
    commandId,
    commandDigest: `digest-${commandId}`,
    participantId: "tier2",
    acceptedAt: 1,
    retainUntil: 2,
    admittedRevision: "0",
    resultingRevision: "1",
  };
  return { digest: receipt.commandDigest, value: encodeCommandReceipt(receipt) };
}

describe("postgres tier-2 concurrency", () => {
  it("admits exactly one winner per head revision under contention", async () => {
    const handle = await openPostgresStorageForTest({ connectionString, migrate: true });
    const kernel: DurableKernel = handle.kernel;
    const conversationId = `tier2-cas-${Date.now()}`;
    const headKey = durableKey(conversationId);

    try {
      const created = await run(() =>
        kernel.apply({
          authority: {
            name: "create",
            collection: DurableCollections.conversationHeads,
            key: headKey,
            expected: { revision: null, fence: null },
            next: { revision: "0", fence: "0", value: headValue(conversationId, 0) },
          },
          ensures: [],
        }),
      );
      expect(created.status).toBe("committed");

      let committed = 0;
      let conflicts = 0;

      await Promise.all(
        Array.from({ length: WORKERS }, async (_, worker) => {
          let done = 0;
          while (done < COMMITS_PER_WORKER) {
            const current = await run(() =>
              kernel.readAuthority(DurableCollections.conversationHeads, headKey),
            );
            if (!current) throw new Error("head vanished");
            const next = BigInt(current.revision) + 1n;
            const outcome: DurableMutationOutcome = await run(() =>
              kernel.apply({
                authority: {
                  name: `worker-${worker}`,
                  collection: DurableCollections.conversationHeads,
                  key: headKey,
                  expected: { revision: current.revision },
                  next: {
                    revision: next.toString(),
                    value: headValue(conversationId, Number(next)),
                  },
                },
                ensures: [],
              }),
            );
            if (outcome.status === "committed") {
              committed += 1;
              done += 1;
            } else if (outcome.status === "authority_conflict") {
              conflicts += 1;
            } else {
              throw new Error(`unexpected outcome: ${JSON.stringify(outcome)}`);
            }
          }
        }),
      );

      // Every worker completed its commits and every conflict was a clean
      // authority conflict — never a stale read winning twice.
      expect(committed).toBe(WORKERS * COMMITS_PER_WORKER);
      expect(conflicts).toBeGreaterThanOrEqual(0);

      const final = await run(() =>
        kernel.readAuthority(DurableCollections.conversationHeads, headKey),
      );
      expect(final?.revision).toBe(String(WORKERS * COMMITS_PER_WORKER));
    } finally {
      await run(() => handle.close());
    }
  });

  it("elects exactly one claim holder under a same-claim race", async () => {
    const handle = await openPostgresStorageForTest({ connectionString, migrate: true });
    const kernel: DurableKernel = handle.kernel;
    const conversationId = `tier2-claim-${Date.now()}`;
    const commandId = `cmd-${Date.now()}`;
    const claimKey = durableKey(conversationId, commandId);
    const claim = receiptValue(conversationId, commandId);

    try {
      const attempts = await Promise.all(
        Array.from({ length: WORKERS }, () =>
          run(() =>
            kernel.apply({
              claim: {
                name: "race-claim",
                collection: DurableCollections.conversationCommandReceipts,
                key: claimKey,
                fingerprint: claim.digest,
                value: claim.value,
              },
              ensures: [],
            }),
          ),
        ),
      );

      const committed = attempts.filter((a) => a.status === "committed");
      const existing = attempts.filter((a) => a.status === "claim_exists");

      // Exactly one worker inserted the claim; everyone else observed the
      // same record the winner wrote.
      expect(committed).toHaveLength(1);
      expect(existing).toHaveLength(WORKERS - 1);
      for (const attempt of existing) {
        if (attempt.status === "claim_exists") {
          expect(attempt.existing.fingerprint).toBe(claim.digest);
        }
      }

      const stored = await run(() =>
        kernel.readImmutable(DurableCollections.conversationCommandReceipts, claimKey),
      );
      expect(stored?.fingerprint).toBe(claim.digest);
    } finally {
      await run(() => handle.close());
    }
  });
});
