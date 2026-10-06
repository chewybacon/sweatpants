import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { canonicalSnapshot, sha256, type Json } from "@sweatpants/foundation";
import { run } from "effection";
import { afterEach, describe, expect, it } from "vitest";
import {
  openBetterSqliteStorage,
  type BetterSqliteStorageHandle,
} from "@sweatpants/storage-sqlite/better-sqlite3";
import { createStorageInspectorApi, type StorageInspectorApi } from "../storage-api.ts";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("storage inspector privacy boundary", () => {
  it("returns metadata without persisted body content", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sweatpants-storage-inspector-"));
    directories.push(directory);
    const databasePath = join(directory, "spine.sqlite");
    const handle = await run(() =>
      openBetterSqliteStorage(databasePath, { initialize: true, wal: false }),
    );
    const secret = "INSPECTOR_PRIVATE_BODY_MARKER";
    try {
      const payload = canonicalSnapshot({
        public: {
          hotRoots: [
            {
              rootId: "message:user-1",
              position: "0",
              kind: "message",
              state: "sealed",
              attribution: {},
              message: { id: "user-1", role: "user", content: secret },
              placement: { type: "root", sequence: 0 },
            },
          ],
          applicationState: {},
        },
      });
      await seedCheckpoint(handle, payload.value, payload.canonical);
    } finally {
      await run(() => handle.close());
    }

    const api = await createStorageInspectorApi(databasePath);
    try {
      const body = await invoke(api, "/api/storage/conversations/conversation-1");
      expect(body).toMatchObject({ bodies: "redacted" });
      expect(body.checkpoints).toEqual([
        expect.objectContaining({
          checkpoint_id: "checkpoint-1",
          lineage_id: "lineage-1",
          archive_frontier_ordinal: "0",
          next_public_position: "1",
        }),
      ]);
      expect(JSON.stringify(body)).not.toContain("archive_through_position");
      expect(JSON.stringify(body)).not.toContain("first_position");
      expect(JSON.stringify(body)).not.toContain("last_position");
      expect(JSON.stringify(body)).not.toContain(secret);
      expect(JSON.stringify(body)).not.toContain("payload_json");
    } finally {
      await api.close();
    }
  });
});

async function seedCheckpoint(
  handle: BetterSqliteStorageHandle,
  payload: Json,
  canonical: string,
): Promise<void> {
  await run(() =>
    handle.storage.conversationStore.putCheckpoint({
      checkpointId: "checkpoint-1",
      conversationId: "conversation-1",
      lineageId: "lineage-1",
      causeKey: "cause-1",
      cause: { kind: "inspector-test" },
      contentHash: sha256(canonical),
      archiveHead: null,
      archiveFrontierOrdinal: "0",
      nextPublicPosition: "1",
      payload,
      encodedBytes: new TextEncoder().encode(canonical).byteLength,
      createdAt: 1,
    }),
  );
}

async function invoke(api: StorageInspectorApi, url: string): Promise<Record<string, unknown>> {
  let body = "";
  const response = {
    statusCode: 0,
    setHeader() {},
    end(value?: string) {
      body = value ?? "";
    },
  } as unknown as ServerResponse;
  api.handle({ method: "GET", url } as IncomingMessage, response, () => {
    throw new Error("unexpected next handler");
  });
  return JSON.parse(body) as Record<string, unknown>;
}
