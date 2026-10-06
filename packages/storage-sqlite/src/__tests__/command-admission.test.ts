import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { run } from "effection";
import { openBetterSqliteStorage } from "../better-sqlite3.ts";
import { openBetterSqliteStorageForTest } from "../testing.ts";
import type { CommandAdmissionRequest, ConversationHeadProposal } from "../contract.ts";

const databases: string[] = [];

async function temporaryDatabase(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "sweatpants-storage-sqlite-"));
  databases.push(directory);
  return join(directory, "spine.sqlite");
}

function idleProposal(): ConversationHeadProposal {
  return {
    state: "idle",
    checkpoint: null,
    terminalHistory: null,
    activeLogicalTurnId: null,
    activeExecutionId: null,
    latestCompletedExecutionId: null,
    activeSegment: null,
    activeCommand: null,
    deletedAt: null,
    ownerTransition: { kind: "preserve" },
  };
}

function runningRequest(commandDigest = "digest-1"): CommandAdmissionRequest {
  return {
    conversationId: "conversation-1",
    commandId: "command-1",
    commandDigest,
    participantId: "participant-1",
    acceptedAt: 100,
    retainUntil: 200,
    expectedRevision: "0",
    requiredState: "idle",
    logicalTurnId: "turn-1",
    executionId: "execution-1",
    proposal: {
      ...idleProposal(),
      state: "running",
      activeLogicalTurnId: "turn-1",
      activeExecutionId: "execution-1",
      activeCommand: { commandId: "command-1" },
      ownerTransition: { kind: "assign", ownerRoute: { host: "host-1" } },
    },
  };
}

afterEach(async () => {
  await Promise.all(databases.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("SQLite command admission", () => {
  it("atomically admits a command and makes an exact retry idempotent", async () => {
    const path = await temporaryDatabase();
    const handle = await run(() => openBetterSqliteStorage(path, { initialize: true, wal: false }));

    try {
      await run(() =>
        handle.storage.conversationStore.compareAndSwapHead(
          "conversation-1",
          null,
          null,
          idleProposal(),
        ),
      );

      const request = runningRequest();
      const admitted = await run(() => handle.storage.conversationStore.admitCommand(request));
      expect(admitted).toMatchObject({
        status: "admitted",
        receipt: {
          conversationId: "conversation-1",
          commandId: "command-1",
          admittedRevision: "0",
          resultingRevision: "1",
        },
        head: { revision: "1", ownerEpoch: "1", state: "running" },
      });

      const retried = await run(() => handle.storage.conversationStore.admitCommand(request));
      expect(retried).toMatchObject({
        status: "idempotent",
        receipt: { commandDigest: "digest-1", resultingRevision: "1" },
        head: { revision: "1", ownerEpoch: "1" },
      });

      const conflicting = await run(() =>
        handle.storage.conversationStore.admitCommand(runningRequest("digest-2")),
      );
      expect(conflicting).toMatchObject({
        status: "command_identity_conflict",
        receipt: { commandDigest: "digest-1" },
      });

      const rows = handle.database.all(
        sql`SELECT command_id, command_digest, admitted_revision, resulting_revision
            FROM sp_conversation_command_receipts`,
      ) as Array<Record<string, unknown>>;
      expect(rows).toHaveLength(1);
    } finally {
      await run(() => handle.close());
    }
  });

  it("rolls back receipt and head together when the admission transaction fails", async () => {
    const path = await temporaryDatabase();
    const handle = await run(() =>
      openBetterSqliteStorageForTest(path, {
        initialize: true,
        wal: false,
        faultInjection: "command-before-commit",
      }),
    );

    try {
      await run(() =>
        handle.storage.conversationStore.compareAndSwapHead(
          "conversation-1",
          null,
          null,
          idleProposal(),
        ),
      );
      await expect(
        run(() => handle.storage.conversationStore.admitCommand(runningRequest())),
      ).rejects.toMatchObject({ code: "durable_kernel_transaction_failed" });

      const head = await run(() => handle.storage.conversationStore.loadHead("conversation-1"));
      expect(head).toMatchObject({ revision: "0", ownerEpoch: "0", state: "idle" });
      const rows = handle.database.all(
        sql`SELECT command_id FROM sp_conversation_command_receipts`,
      ) as Array<Record<string, unknown>>;
      expect(rows).toEqual([]);
    } finally {
      await run(() => handle.close());
    }
  });
});
