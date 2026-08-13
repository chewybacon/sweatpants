import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { run } from "effection";
import { openBetterSqliteStorage } from "../better-sqlite3.ts";
import { spConversationHeads } from "../schema.ts";

const databases: string[] = [];
const ABOVE_SAFE_INTEGER = "9007199254740993";

async function temporaryDatabase(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "sweatpants-storage-sqlite-"));
  databases.push(directory);
  return join(directory, "spine.sqlite");
}

afterEach(async () => {
  await Promise.all(databases.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("SQLite durable counters", () => {
  it("round-trips values above Number.MAX_SAFE_INTEGER and increments in SQLite", async () => {
    const path = await temporaryDatabase();
    const handle = await run(() => openBetterSqliteStorage(path, { migrate: true, wal: false }));

    try {
      handle.database
        .insert(spConversationHeads)
        .values({
          conversationId: "counter-conversation",
          revision: ABOVE_SAFE_INTEGER,
          ownerEpoch: ABOVE_SAFE_INTEGER,
          ownerRouteJson: null,
          state: "idle",
          checkpointId: null,
          terminalSegmentId: null,
          activeLogicalTurnId: null,
          activeExecutionId: null,
          latestCompletedExecutionId: null,
          activeSegmentJson: null,
          activeCommandJson: null,
          deletedAt: null,
          updatedAt: 1,
        })
        .run();

      const loaded = await run(() =>
        handle.storage.conversationStore.loadHead("counter-conversation"),
      );
      expect(loaded).toMatchObject({
        revision: ABOVE_SAFE_INTEGER,
        ownerEpoch: ABOVE_SAFE_INTEGER,
      });
      const next = await run(() =>
        handle.storage.conversationStore.compareAndSwapHead(
          "counter-conversation",
          ABOVE_SAFE_INTEGER,
          ABOVE_SAFE_INTEGER,
          {
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
          },
        ),
      );
      expect(next).toMatchObject({
        status: "committed",
        head: { revision: "9007199254740994", ownerEpoch: ABOVE_SAFE_INTEGER },
      });
    } finally {
      await run(() => handle.close());
    }
  });

  it("rejects a counter outside signed SQLite INTEGER range", async () => {
    const path = await temporaryDatabase();
    const handle = await run(() => openBetterSqliteStorage(path, { migrate: true, wal: false }));
    try {
      expect(() =>
        handle.database
          .insert(spConversationHeads)
          .values({
            conversationId: "invalid-counter",
            revision: "9223372036854775808",
            ownerEpoch: "0",
            ownerRouteJson: null,
            state: "idle",
            checkpointId: null,
            terminalSegmentId: null,
            activeLogicalTurnId: null,
            activeExecutionId: null,
            latestCompletedExecutionId: null,
            activeSegmentJson: null,
            activeCommandJson: null,
            deletedAt: null,
            updatedAt: 1,
          })
          .run(),
      ).toThrowError(expect.objectContaining({ code: "sqlite_integer_out_of_range" }));
    } finally {
      await run(() => handle.close());
    }
  });
});
