import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { run } from "effection";
import type { Json } from "@sweatpants/foundation";
import { withConversationStore } from "./with-conversation-store.ts";
import {
  hydratePublicRoots,
  persistConversationCheckpoint,
  readAllPublicRootsForModel,
} from "../index.ts";
import { LOW_CHECKPOINT_TARGETS } from "@sweatpants/history-store";
import { openBetterSqliteStorage } from "@sweatpants/storage-sqlite/better-sqlite3";

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

function messageEvents(prefix: string, count: number) {
  return Array.from({ length: count }, (_, index): Json[] => {
    const id = `${prefix}-${index}`;
    return [
      { type: "TEXT_MESSAGE_START", messageId: id, role: "user" },
      { type: "TEXT_MESSAGE_CONTENT", messageId: id, delta: id },
      { type: "TEXT_MESSAGE_END", messageId: id },
    ];
  }).flat();
}

describe("checkpoint archive reconstruction", () => {
  it("uses bounded hot hydration and indexed model-history reconstruction", async () => {
    const path = await temporaryDatabase();
    const handle = await run(() => openBetterSqliteStorage(path, { initialize: true, wal: false }));
    try {
      await run(function* () {
        yield* handle.storage.conversationStore.compareAndSwapHead(
          "conversation-1",
          null,
          null,
          idle,
        );
        yield* withConversationStore(handle.storage.conversationStore, () =>
          persistConversationCheckpoint({
            conversationId: "conversation-1",
            causeKey: "first",
            cause: { kind: "command", commandId: "first" },
            roots: messageEvents("first", 10),
            proposal: idle,
            createdAt: 1,
            targets: LOW_CHECKPOINT_TARGETS,
          }),
        );
        const second = yield* withConversationStore(handle.storage.conversationStore, () =>
          persistConversationCheckpoint({
            conversationId: "conversation-1",
            causeKey: "second",
            cause: { kind: "command", commandId: "second" },
            roots: messageEvents("second", 2),
            proposal: idle,
            createdAt: 2,
            targets: LOW_CHECKPOINT_TARGETS,
          }),
        );
        expect(BigInt(second.checkpoint.archiveFrontierOrdinal)).toBeGreaterThan(0n);
        expect(BigInt(second.checkpoint.nextPublicPosition)).toBeGreaterThanOrEqual(2n);

        const hot = hydratePublicRoots(second.checkpoint);
        expect(hot.length).toBeLessThanOrEqual(LOW_CHECKPOINT_TARGETS.spill.maxRoots);
        const reconstructed = yield* withConversationStore(handle.storage.conversationStore, () =>
          readAllPublicRootsForModel("conversation-1", second.checkpoint, 64 * 1024 * 1024),
        );
        const ids = reconstructed.flatMap((root) => {
          const value = root as { kind?: string; message?: { id?: string } };
          return value.kind === "message" && value.message?.id ? [value.message.id] : [];
        });
        expect(ids).toEqual([
          ...Array.from({ length: 10 }, (_, index) => `first-${index}`),
          "second-0",
          "second-1",
        ]);
      });
    } finally {
      await run(() => handle.close());
    }
  });

  it("rejects an old versioned events envelope", async () => {
    const path = await temporaryDatabase();
    const handle = await run(() => openBetterSqliteStorage(path, { initialize: true, wal: false }));
    try {
      await expect(
        run(() =>
          handle.storage.conversationStore.putCheckpoint({
            checkpointId: "old",
            conversationId: "conversation-1",
            lineageId: "lineage-1",
            causeKey: "old",
            cause: { kind: "legacy" },
            contentHash: "0".repeat(64),
            archiveHead: null,
            archiveFrontierOrdinal: "0",
            nextPublicPosition: "0",
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
