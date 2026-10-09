import { DurableCollections, durableKey } from "@sweatpants/durable-storage-kernel";
import { prepareExecutionObject } from "@sweatpants/journal-authority";
import { canonicalJson, sha256 } from "@sweatpants/foundation";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "effection";
import { afterEach, describe, expect, it } from "vitest";
import { openBetterSqliteStorageForTest } from "../better-sqlite3.ts";

const directories: string[] = [];

async function databasePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "sweatpants-kernel-conformance-"));
  directories.push(directory);
  return join(directory, "kernel.sqlite");
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

const control = {
  executionId: "execution",
  controlRevision: "0",
  ownerFence: "0",
  status: "active" as const,
  rootTaskId: "root",
  stopGeneration: "0",
  requestedDisposition: null,
  control: { state: "active" },
  updatedAt: 1,
};

const head = {
  conversationId: "conversation",
  revision: "0",
  ownerEpoch: "0",
  ownerRoute: null,
  state: "idle" as const,
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

describe("SQLite durable kernel conformance", () => {
  it("checks claims before authority guards", async () => {
    const path = await databasePath();
    const handle = await run(() =>
      openBetterSqliteStorageForTest(path, { initialize: true, wal: false }),
    );
    try {
      await run(function* () {
        const receipt = {
          conversationId: "conversation",
          commandId: "command",
          commandDigest: "digest",
          participantId: "participant",
          acceptedAt: 1,
          retainUntil: 2,
          admittedRevision: "0",
          resultingRevision: "1",
        };
        const claim = {
          name: "receipt",
          collection: DurableCollections.conversationCommandReceipts,
          key: durableKey("conversation", "command"),
          fingerprint: receipt.commandDigest,
          value: receipt,
        } as const;
        expect(yield* handle.kernel.apply({ claim, ensures: [] })).toMatchObject({
          status: "committed",
        });
        expect(
          yield* handle.kernel.apply({
            claim,
            ensures: [],
            authority: {
              name: "head",
              collection: DurableCollections.conversationHeads,
              key: durableKey("conversation"),
              expected: { revision: "99", fence: "99" },
              next: {
                revision: "100",
                fence: "99",
                value: head,
              },
            },
          }),
        ).toMatchObject({ status: "claim_exists", claim: "receipt" });
      });
    } finally {
      await run(() => handle.close());
    }
  });

  it("rolls back immutable ensures when an authority guard conflicts", async () => {
    const path = await databasePath();
    const handle = await run(() =>
      openBetterSqliteStorageForTest(path, { initialize: true, wal: false }),
    );
    try {
      await run(function* () {
        yield* handle.kernel.apply({
          ensures: [],
          authority: {
            name: "control",
            collection: DurableCollections.executionControls,
            key: durableKey("execution"),
            expected: { revision: null, fence: "0" },
            next: {
              revision: "0",
              fence: "0",
              value: control,
            },
          },
        });
        const body = { payload: true };
        const snapshot = canonicalJson(body);
        const snapshotDigest = sha256(snapshot);
        const object = {
          objectId: "object",
          lifetimeScope: "execution" as const,
          scopeOwnerId: "execution",
          objectKind: "test",
          contentHash: snapshotDigest,
          byteLength: new TextEncoder().encode(snapshot).byteLength,
          body,
          createdAt: 1,
        };
        const objectKey = durableKey(object.objectId);
        expect(
          yield* handle.kernel.apply({
            ensures: [
              {
                name: "object",
                collection: DurableCollections.executionObjects,
                key: objectKey,
                fingerprint: object.contentHash,
                value: prepareExecutionObject(object),
              },
            ],
            authority: {
              name: "control",
              collection: DurableCollections.executionControls,
              key: durableKey("execution"),
              expected: { revision: "9", fence: "0" },
              next: {
                revision: "10",
                fence: "0",
                value: { ...control, controlRevision: "10" },
              },
            },
          }),
        ).toMatchObject({ status: "authority_conflict", mismatch: "revision" });
        expect(
          yield* handle.kernel.readImmutable(DurableCollections.executionObjects, objectKey),
        ).toBeNull();
      });
    } finally {
      await run(() => handle.close());
    }
  });
});
