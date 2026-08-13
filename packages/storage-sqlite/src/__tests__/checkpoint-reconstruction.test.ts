import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { run } from "effection";
import {
  hydratePublicRoots,
  persistConversationCheckpoint,
} from "@sweatpants/durable-chat-runtime";
import { LOW_CHECKPOINT_TARGETS } from "@sweatpants/history-store";
import { openBetterSqliteStorage } from "../better-sqlite3.ts";

const databases: string[] = [];

async function temporaryDatabase(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "sweatpants-storage-sqlite-"));
  databases.push(directory);
  return join(directory, "spine.sqlite");
}

afterEach(async () => {
  await Promise.all(databases.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const idle = {
  state: "idle" as const,
  checkpoint: null,
  terminalHistory: null,
  activeLogicalTurnId: null,
  activeExecutionId: null,
  latestCompletedExecutionId: null,
  activeSegment: null,
  activeCommand: null,
  deletedAt: null,
  ownerTransition: { kind: "preserve" as const },
};

describe("checkpoint archive reconstruction", () => {
  it("preserves archive lastPosition across two checkpoint publications", async () => {
    const path = await temporaryDatabase();
    const handle = await run(() => openBetterSqliteStorage(path, { migrate: true, wal: false }));
    try {
      await run(function* () {
        yield* handle.storage.conversationStore.compareAndSwapHead(
          "conversation-1",
          null,
          null,
          idle,
        );
        const firstRoots = Array.from({ length: 10 }, (_, index) => ({ id: `first-${index}` }));
        yield* persistConversationCheckpoint(handle.storage.conversationStore, {
          conversationId: "conversation-1",
          causeKey: "first",
          cause: { kind: "command", commandId: "first" },
          roots: firstRoots,
          proposal: idle,
          createdAt: 1,
          targets: LOW_CHECKPOINT_TARGETS,
        });

        const secondRoots = Array.from({ length: 2 }, (_, index) => ({ id: `second-${index}` }));
        const second = yield* persistConversationCheckpoint(handle.storage.conversationStore, {
          conversationId: "conversation-1",
          causeKey: "second",
          cause: { kind: "command", commandId: "second" },
          roots: secondRoots,
          proposal: idle,
          createdAt: 2,
          targets: LOW_CHECKPOINT_TARGETS,
        });
        expect(second.checkpoint.archiveHead?.lastPosition).toBe(
          second.checkpoint.archiveThroughPosition,
        );
        expect(second.checkpoint.archiveHead?.lastPosition).not.toBe("0");

        const thirdRoots = [{ id: "third-0" }];
        const third = yield* persistConversationCheckpoint(handle.storage.conversationStore, {
          conversationId: "conversation-1",
          causeKey: "third",
          cause: { kind: "command", commandId: "third" },
          roots: thirdRoots,
          proposal: idle,
          createdAt: 3,
          targets: LOW_CHECKPOINT_TARGETS,
        });
        expect(BigInt(third.checkpoint.archiveThroughPosition)).toBeGreaterThanOrEqual(
          BigInt(second.checkpoint.archiveThroughPosition),
        );
        expect(third.checkpoint.archiveHead?.lastPosition).toBe(
          third.checkpoint.archiveThroughPosition,
        );

        const reconstructed = yield* hydratePublicRoots(
          handle.storage.conversationStore,
          "conversation-1",
          third.checkpoint,
        );
        const ids = reconstructed.map((root) => (root as { id: string }).id);
        expect(ids).toEqual([...firstRoots, ...secondRoots, ...thirdRoots].map((root) => root.id));
        expect(new Set(ids).size).toBe(ids.length);
      });
    } finally {
      await run(() => handle.close());
    }
  });

  it("rejects an old versioned events envelope", async () => {
    const path = await temporaryDatabase();
    const handle = await run(() => openBetterSqliteStorage(path, { migrate: true, wal: false }));
    try {
      await expect(
        run(() =>
          handle.storage.conversationStore.putCheckpoint({
            checkpointId: "old",
            conversationId: "conversation-1",
            causeKey: "old",
            cause: { kind: "legacy" },
            contentHash: "0".repeat(64),
            archiveHead: null,
            archiveThroughPosition: "0",
            payload: { version: 1, events: [{ type: "TEXT_MESSAGE_START" }] },
            encodedBytes: 2,
            createdAt: 1,
          }),
        ),
      ).rejects.toMatchObject({ code: "persisted_data_invalid" });
    } finally {
      await run(() => handle.close());
    }
  });
});
