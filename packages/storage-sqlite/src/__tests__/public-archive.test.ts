import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { canonicalSnapshot, sha256, type Json } from "@sweatpants/foundation";
import { run } from "effection";
import { openBetterSqliteStorage } from "../better-sqlite3.ts";
import type { StoredPublicArchiveSegment } from "../contract.ts";

const databases: string[] = [];

async function temporaryDatabase(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "sweatpants-storage-sqlite-"));
  databases.push(directory);
  return join(directory, "spine.sqlite");
}

function segment(
  segmentId: string,
  firstPosition: string,
  roots: readonly Json[],
  previous: StoredPublicArchiveSegment["previous"] = null,
): StoredPublicArchiveSegment {
  const snapshot = canonicalSnapshot(roots);
  return {
    segmentId,
    conversationId: "conversation-1",
    previous,
    firstPosition,
    lastPosition: String(Number(firstPosition) + roots.length - 1),
    roots: snapshot.value,
    contentHash: sha256(snapshot.canonical),
    encodedBytes: new TextEncoder().encode(snapshot.canonical).byteLength,
    createdAt: 100,
  };
}

afterEach(async () => {
  await Promise.all(databases.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("SQLite public archive segments", () => {
  it("preserves immutable ranges and pages roots in causal order", async () => {
    const path = await temporaryDatabase();
    const handle = await run(() => openBetterSqliteStorage(path, { migrate: true, wal: false }));

    try {
      const first = segment("segment-1", "0", [{ position: 0 }, { position: 1 }]);
      const second = segment("segment-2", "2", [{ position: 2 }, { position: 3 }], {
        segmentId: "segment-1",
        lastPosition: "1",
      });
      expect(
        await run(() => handle.storage.conversationStore.putPublicArchiveSegment(first)),
      ).toEqual({
        segmentId: "segment-1",
        lastPosition: "1",
      });
      expect(
        await run(() => handle.storage.conversationStore.putPublicArchiveSegment(second)),
      ).toEqual({
        segmentId: "segment-2",
        lastPosition: "3",
      });

      const page = await run(() =>
        handle.storage.conversationStore.readPublicArchivePage("conversation-1", undefined, 3),
      );
      expect(page).toEqual({
        roots: [{ position: 0 }, { position: 1 }, { position: 2 }],
        nextCursor: "3",
        head: { segmentId: "segment-2", lastPosition: "3" },
      });
      const last = await run(() =>
        handle.storage.conversationStore.readPublicArchivePage(
          "conversation-1",
          page.nextCursor ?? undefined,
          3,
        ),
      );
      expect(last).toEqual({
        roots: [{ position: 3 }],
        nextCursor: null,
        head: { segmentId: "segment-2", lastPosition: "3" },
      });

      const rows = handle.database.all(
        sql`SELECT segment_id, previous_segment_id, first_position, last_position
            FROM sp_conversation_public_segments ORDER BY first_position`,
      ) as Array<Record<string, unknown>>;
      expect(rows).toHaveLength(2);
      expect(rows[1]).toMatchObject({ segment_id: "segment-2", previous_segment_id: "segment-1" });
    } finally {
      await run(() => handle.close());
    }
  });

  it("makes exact retries idempotent and rejects a changed immutable body", async () => {
    const path = await temporaryDatabase();
    const handle = await run(() => openBetterSqliteStorage(path, { migrate: true, wal: false }));

    try {
      const first = segment("segment-1", "0", [{ value: "first" }]);
      await run(() => handle.storage.conversationStore.putPublicArchiveSegment(first));
      await expect(
        run(() =>
          handle.storage.conversationStore.putPublicArchiveSegment({
            ...first,
            roots: [{ value: "changed" }],
            contentHash: sha256(canonicalSnapshot([{ value: "changed" }]).canonical),
          }),
        ),
      ).rejects.toMatchObject({ code: "immutable_object_conflict" });
    } finally {
      await run(() => handle.close());
    }
  });
});
