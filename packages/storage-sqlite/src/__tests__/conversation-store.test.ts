import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { run } from "effection";
import { openBetterSqliteStorage } from "../better-sqlite3.ts";
import type { ConversationHeadProposal } from "../contract.ts";

const databases: string[] = [];

async function temporaryDatabase(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "sweatpants-storage-sqlite-"));
  databases.push(directory);
  return join(directory, "spine.sqlite");
}

function proposal(overrides: Partial<ConversationHeadProposal> = {}): ConversationHeadProposal {
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
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(databases.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("SQLite ConversationStore", () => {
  it("assigns initial and subsequent head counters inside the store", async () => {
    const path = await temporaryDatabase();
    const handle = await run(() => openBetterSqliteStorage(path, { migrate: true, wal: false }));

    try {
      const first = await run(() =>
        handle.storage.conversationStore.compareAndSwapHead(
          "conversation-1",
          null,
          null,
          proposal(),
        ),
      );
      expect(first).toMatchObject({
        status: "committed",
        head: { conversationId: "conversation-1", revision: "0", ownerEpoch: "0" },
      });

      const running = await run(() =>
        handle.storage.conversationStore.compareAndSwapHead(
          "conversation-1",
          "0",
          "0",
          proposal({
            state: "running",
            activeLogicalTurnId: "turn-1",
            activeExecutionId: "execution-1",
            ownerTransition: { kind: "assign", ownerRoute: { host: "host-1" } },
          }),
        ),
      );
      expect(running).toMatchObject({
        status: "committed",
        head: {
          revision: "1",
          ownerEpoch: "1",
          state: "running",
          ownerRoute: { host: "host-1" },
        },
      });

      const stale = await run(() =>
        handle.storage.conversationStore.compareAndSwapHead("conversation-1", "0", "0", proposal()),
      );
      expect(stale).toMatchObject({
        status: "head_conflict",
        current: { revision: "1", ownerEpoch: "1" },
      });
    } finally {
      await run(() => handle.close());
    }
  });
});
