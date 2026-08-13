import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { canonicalSnapshot, sha256, type Json } from "@sweatpants/foundation";
import { run } from "effection";
import { openBetterSqliteStorage } from "../better-sqlite3.ts";
import type { StoredTerminalSegment } from "../contract.ts";

const databases: string[] = [];

async function temporaryDatabase(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "sweatpants-storage-sqlite-"));
  databases.push(directory);
  return join(directory, "spine.sqlite");
}

function segment(
  segmentId: string,
  publicationKey: string,
  firstPosition: string,
  entries: readonly Json[],
  previous: StoredTerminalSegment["previous"] = null,
): StoredTerminalSegment {
  const snapshot = canonicalSnapshot(entries);
  return {
    segmentId,
    conversationId: "conversation-1",
    logicalTurnId: "turn-1",
    executionId: "execution-1",
    publicationKey,
    previous,
    firstPosition,
    lastPosition: String(Number(firstPosition) + entries.length - 1),
    entries: snapshot.value,
    contentHash: sha256(snapshot.canonical),
    createdAt: 100,
  };
}

afterEach(async () => {
  await Promise.all(databases.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("SQLite terminal history", () => {
  it("stores one immutable publication and pages ordered chat turns", async () => {
    const path = await temporaryDatabase();
    const handle = await run(() => openBetterSqliteStorage(path, { migrate: true, wal: false }));

    try {
      const first = segment("terminal-1", "publication-1", "0", [
        { event: "start" },
        { event: "done" },
      ]);
      const second = segment("terminal-2", "publication-2", "2", [{ event: "next" }], {
        segmentId: "terminal-1",
        lastPosition: "1",
      });
      expect(
        await run(() => handle.storage.conversationStore.putTerminalHistorySegment(first)),
      ).toEqual({
        segmentId: "terminal-1",
        lastPosition: "1",
      });
      expect(
        await run(() => handle.storage.conversationStore.putTerminalHistorySegment(second)),
      ).toEqual({
        segmentId: "terminal-2",
        lastPosition: "2",
      });

      const page = await run(() =>
        handle.storage.conversationStore.readTerminalHistoryPage("conversation-1", undefined, 2),
      );
      expect(page).toEqual({
        entries: [{ event: "start" }, { event: "done" }],
        nextCursor: "2",
        head: { segmentId: "terminal-2", lastPosition: "2" },
      });
      const next = await run(() =>
        handle.storage.conversationStore.readTerminalHistoryPage(
          "conversation-1",
          page.nextCursor ?? undefined,
          2,
        ),
      );
      expect(next).toEqual({
        entries: [{ event: "next" }],
        nextCursor: null,
        head: { segmentId: "terminal-2", lastPosition: "2" },
      });

      const rows = handle.database.all(
        sql`SELECT segment_id, publication_key, entries_json
            FROM sp_conversation_terminal_segments ORDER BY first_position`,
      ) as Array<Record<string, unknown>>;
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({
        publication_key: "publication-1",
        entries_json: '[{"event":"start"},{"event":"done"}]',
      });
    } finally {
      await run(() => handle.close());
    }
  });

  it("makes a same-publication retry idempotent and conflicts on changed content", async () => {
    const path = await temporaryDatabase();
    const handle = await run(() => openBetterSqliteStorage(path, { migrate: true, wal: false }));

    try {
      const first = segment("terminal-1", "publication-1", "0", [{ event: "done" }]);
      await run(() => handle.storage.conversationStore.putTerminalHistorySegment(first));
      const retry = await run(() =>
        handle.storage.conversationStore.putTerminalHistorySegment({
          ...first,
          segmentId: "terminal-retry",
        }),
      );
      expect(retry).toEqual({ segmentId: "terminal-1", lastPosition: "0" });
      await expect(
        run(() =>
          handle.storage.conversationStore.putTerminalHistorySegment({
            ...segment("terminal-2", "publication-1", "0", [{ event: "changed" }]),
          }),
        ),
      ).rejects.toMatchObject({ code: "immutable_object_conflict" });
    } finally {
      await run(() => handle.close());
    }
  });
});
