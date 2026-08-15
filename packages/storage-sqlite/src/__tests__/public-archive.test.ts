import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { canonicalSnapshot, type Json } from "@sweatpants/foundation";
import { run } from "effection";
import { openBetterSqliteStorage } from "../better-sqlite3.ts";
import type { StoredPublicArchiveSegment } from "../contract.ts";

const databases: string[] = [];

async function temporaryDatabase(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "sweatpants-storage-sqlite-"));
  databases.push(directory);
  return join(directory, "spine.sqlite");
}

function root(id: string, position: string): Json {
  return {
    rootId: id,
    position,
    kind: "message",
    state: "sealed",
    attribution: {},
    message: { id, role: "user", content: id },
    placement: { type: "root", sequence: Number(position) },
  };
}

function segment(
  segmentId: string,
  roots: readonly Json[],
  previous: StoredPublicArchiveSegment["previous"] = null,
): StoredPublicArchiveSegment {
  const snapshot = canonicalSnapshot(roots);
  const positions = roots.map((value) =>
    BigInt((value as Record<string, Json>)["position"] as string),
  );
  return {
    segmentId,
    conversationId: "conversation-1",
    previous,
    minPosition: positions.reduce((left, right) => (left < right ? left : right)).toString(10),
    maxPosition: positions.reduce((left, right) => (left > right ? left : right)).toString(10),
    roots: snapshot.value,
    contentHash: snapshot.sha,
    encodedBytes: new TextEncoder().encode(snapshot.canonical).byteLength,
    createdAt: 100,
  };
}

afterEach(async () => {
  await Promise.all(databases.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("SQLite public archive segments", () => {
  it("stores immutable noncontiguous segments without prefix authority", async () => {
    const path = await temporaryDatabase();
    const handle = await run(() => openBetterSqliteStorage(path, { migrate: true, wal: false }));
    try {
      const first = segment("segment-1", [root("root-2", "2"), root("root-7", "7")]);
      const second = segment("segment-2", [root("root-1", "1")], {
        segmentId: first.segmentId,
      });
      expect(
        await run(() => handle.storage.conversationStore.putPublicArchiveSegment(first)),
      ).toEqual({ segmentId: "segment-1" });
      expect(
        await run(() => handle.storage.conversationStore.putPublicArchiveSegment(second)),
      ).toEqual({ segmentId: "segment-2" });

      const rows = handle.database.all(
        sql`SELECT segment_id, previous_segment_id, min_position, max_position
            FROM sp_conversation_public_segments ORDER BY created_at, segment_id`,
      ) as Array<Record<string, unknown>>;
      expect(rows).toEqual([
        expect.objectContaining({
          segment_id: "segment-1",
          previous_segment_id: null,
          min_position: 2n,
          max_position: 7n,
        }),
        expect.objectContaining({
          segment_id: "segment-2",
          previous_segment_id: "segment-1",
          min_position: 1n,
          max_position: 1n,
        }),
      ]);
    } finally {
      await run(() => handle.close());
    }
  });

  it("makes exact retries idempotent and rejects changed immutable content", async () => {
    const path = await temporaryDatabase();
    const handle = await run(() => openBetterSqliteStorage(path, { migrate: true, wal: false }));
    try {
      const first = segment("segment-1", [root("root-0", "0")]);
      await run(() => handle.storage.conversationStore.putPublicArchiveSegment(first));
      expect(
        await run(() => handle.storage.conversationStore.putPublicArchiveSegment(first)),
      ).toEqual({ segmentId: "segment-1" });
      const changed = segment("segment-1", [root("changed", "0")]);
      await expect(
        run(() => handle.storage.conversationStore.putPublicArchiveSegment(changed)),
      ).rejects.toMatchObject({ code: "immutable_object_conflict" });
    } finally {
      await run(() => handle.close());
    }
  });
});
