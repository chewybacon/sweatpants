/**
 * Tier-2 conformance: concurrency semantics that exercise the Postgres
 * locking model directly. Tier-1 (single-threaded conformance) runs in the
 * shared store suites; these cases prove that contention resolves into
 * deterministic outcomes — one winner per revision, one claim holder, and
 * never a lost update.
 */
import { run } from "effection";
import { randomUUID } from "node:crypto";
import type { QueryConfig } from "pg";
import { canonicalSnapshot } from "@sweatpants/foundation";
import { encodePrivateSegment } from "@sweatpants/journal-authority/store-persistence";
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
} from "@sweatpants/history-store/persistence";
import type { CommandReceipt, ConversationHead } from "@sweatpants/history-store/contract";
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
    const handle = await openPostgresStorageForTest({ connectionString, initialize: true });
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
    const handle = await openPostgresStorageForTest({ connectionString, initialize: true });
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

it.each(["conflicting", "identical"] as const)(
  "reconciles %s ensure-only insert races and rolls back partial batches",
  async (kind) => {
    let retries = 0;
    const handle = await openPostgresStorageForTest({
      connectionString,
      initialize: true,
      faultInjection: (point) => {
        if (point === "ensure-insert-race-retry") retries++;
      },
    });
    const executionId = `tier2-ensure-${randomUUID()}`;
    const sharedIds = new Set([`${executionId}-shared-a`, `${executionId}-shared-b`]);
    const connect = handle.pool.connect.bind(handle.pool);
    let readers = 0;
    let release!: () => void;
    const bothRead = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Hold both real Postgres reads after they saw an empty range, before either insert.
    handle.pool.connect = (async () => {
      const client = await connect();
      const query = client.query.bind(client);
      const releaseClient = client.release.bind(client);
      client.query = (async (config: QueryConfig, values?: unknown[]) => {
        const result = await query(config, values);
        if (
          config.text?.startsWith("select") &&
          config.text.includes('from "sp_execution_journal_segments"') &&
          (values ?? config.values ?? []).some(
            (value: unknown) => typeof value === "string" && sharedIds.has(value),
          )
        ) {
          if (++readers === 2) release();
          await bothRead;
        }
        return result;
      }) as typeof client.query;
      client.release = (error?: boolean | Error) => {
        client.query = query;
        client.release = releaseClient;
        releaseClient(error);
      };
      return client;
    }) as typeof handle.pool.connect;
    function segment(id: string, sequence: string, body: string, name: string) {
      const entries = [body];
      const snapshot = canonicalSnapshot(entries);
      return {
        name,
        collection: DurableCollections.executionJournalSegments,
        key: durableKey(id),
        alternateKeys: [durableKey(executionId, "task", sequence, sequence)],
        fingerprint: snapshot.sha,
        value: encodePrivateSegment({
          segmentId: id,
          executionId,
          taskId: "task",
          previous: null,
          firstSequence: sequence,
          lastSequence: sequence,
          entries,
          contentHash: snapshot.sha,
          encodedBytes: new TextEncoder().encode(snapshot.canonical).byteLength,
          createdAt: 1,
        }),
      };
    }
    const writers = ["a", "b"].map((writer, index) => ({
      ensures: [
        segment(`${executionId}-unique-${writer}`, String(index + 2), writer, "unique"),
        segment(
          `${executionId}-shared-${writer}`,
          "1",
          kind === "identical" ? "same" : writer,
          "shared",
        ),
      ],
    }));
    try {
      const outcomes = await Promise.all(
        writers.map((mutation) => run(() => handle.kernel.apply(mutation))),
      );
      handle.pool.connect = connect;
      expect(retries).toBeGreaterThanOrEqual(1);
      const stored = await handle.pool.query(
        "SELECT segment_id FROM sp_execution_journal_segments WHERE execution_id=$1",
        [executionId],
      );
      if (kind === "conflicting") {
        expect(outcomes.map((outcome) => outcome.status).sort()).toEqual([
          "committed",
          "immutable_conflict",
        ]);
        const loser = outcomes.findIndex((outcome) => outcome.status === "immutable_conflict");
        expect(stored.rows.map((row) => row.segment_id)).not.toContain(
          `${executionId}-unique-${["a", "b"][loser]}`,
        );
        expect(stored.rows).toHaveLength(2);
      } else {
        expect(outcomes.map((outcome) => outcome.status)).toEqual(["committed", "committed"]);
        if (outcomes[0].status !== "committed" || outcomes[1].status !== "committed")
          throw new Error("Expected committed replays");
        expect(outcomes[0].ensured.shared.key).toBe(outcomes[1].ensured.shared.key);
        expect(stored.rows).toHaveLength(3);
      }
    } finally {
      handle.pool.connect = connect;
      await run(() => handle.close());
    }
  },
);
