import { call, run } from "effection";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { canonicalSnapshot, sha256, sha256Bytes, type Json } from "@sweatpants/foundation";
import type { RedisClientType } from "redis";
import { createRedisExecutionStore } from "../execution-store.ts";
import { cleanupRedisBackend, connectRedisBackend, type RedisBackend } from "./redis-backend.ts";
import type {
  CommitExecutionRequest,
  StoredPrivateSegment,
} from "@sweatpants/journal-authority/store";

const keyPrefix = `test:${process.pid}:execution-store:`;
let backend: RedisBackend;
let client: RedisClientType;

function initial(executionId: string): CommitExecutionRequest {
  return {
    executionId,
    expectedControlRevision: null,
    expectedOwnerFence: "0",
    nextControl: {
      executionId,
      ownerFence: "0",
      status: "active",
      rootTaskId: "root",
      stopGeneration: "0",
      requestedDisposition: null,
      control: { executionId },
    },
    updatedAt: 1,
  };
}

function segment(
  segmentId: string,
  previous: StoredPrivateSegment["previous"],
  entries: readonly Json[],
): StoredPrivateSegment {
  const encoded = canonicalSnapshot(entries);
  const firstSequence = previous ? (BigInt(previous.lastSequence) + 1n).toString(10) : "1";
  return {
    segmentId,
    executionId: "one",
    taskId: "root",
    previous,
    firstSequence,
    lastSequence: (BigInt(firstSequence) + BigInt(entries.length - 1)).toString(10),
    entries,
    contentHash: sha256(encoded.canonical),
    encodedBytes: new TextEncoder().encode(encoded.canonical).byteLength,
    createdAt: 1,
  };
}

describe("Redis Execution Store", () => {
  beforeAll(async () => {
    backend = await connectRedisBackend();
    client = backend.client;
  });

  afterAll(async () => {
    await cleanupRedisBackend(backend, keyPrefix);
  });

  it("reports which backend certified this run", () => {
    console.info(`[execution-store-redis] execution-store backend: ${backend.label}`);
  });

  it("CAS-isolates executions and atomically stores private segments", async () => {
    const store = createRedisExecutionStore(client, { keyPrefix });
    await run(function* () {
      expect(yield* store.commitExecution(initial("one"))).toMatchObject({
        status: "committed",
        control: { controlRevision: "0" },
      });
      expect(yield* store.commitExecution(initial("two"))).toMatchObject({
        status: "committed",
        control: { controlRevision: "0" },
      });
      expect(
        yield* store.commitExecution({
          ...initial("one"),
          nextControl: { ...initial("one").nextControl, control: { stale: true } },
        }),
      ).toMatchObject({ status: "control_conflict" });
      expect((yield* store.loadControl("two"))?.executionId).toBe("two");
    });
  });

  it("round-trips immutable JSON and binary execution objects", async () => {
    const store = createRedisExecutionStore(client, { keyPrefix });
    await run(function* () {
      const jsonBody = { nested: [true, null, "value"] };
      const jsonEncoded = canonicalSnapshot(jsonBody);
      const json = {
        objectId: "json-object",
        lifetimeScope: "execution" as const,
        scopeOwnerId: "one",
        objectKind: "test-json",
        contentHash: jsonEncoded.sha,
        byteLength: new TextEncoder().encode(jsonEncoded.canonical).byteLength,
        body: jsonBody,
        createdAt: 1,
      };
      const jsonPointer = yield* store.putObject(json);
      expect(yield* store.getObject(jsonPointer)).toEqual(json);
      const bytesBody = new Uint8Array([0, 1, 254, 255]);
      const bytes = {
        objectId: "bytes-object",
        lifetimeScope: "conversation" as const,
        scopeOwnerId: "conversation",
        objectKind: "test-bytes",
        contentHash: sha256Bytes(bytesBody),
        byteLength: bytesBody.byteLength,
        body: bytesBody,
        createdAt: 1,
      };
      const bytesPointer = yield* store.putObject(bytes);
      expect(yield* store.getObject(bytesPointer)).toMatchObject({
        objectId: "bytes-object",
        body: new Uint8Array([0, 1, 254, 255]),
      });
    });
  });

  it("rejects malformed persisted control instead of accepting a partial shape", async () => {
    const store = createRedisExecutionStore(client, { keyPrefix });
    await client.set(
      `${keyPrefix}execution:{malformed}:control`,
      JSON.stringify({ executionId: "malformed", controlRevision: "0", ownerFence: "0" }),
    );
    await run(function* () {
      let error: unknown;
      try {
        yield* store.loadControl("malformed");
      } catch (cause) {
        error = cause;
      }
      expect(error).toMatchObject({ code: "persisted_data_invalid" });
    });
  });

  it("rejects an execution BLOB whose hash does not match its exact bytes", async () => {
    const store = createRedisExecutionStore(client, { keyPrefix });
    const body = new Uint8Array([0, 255, 1, 128]);
    const wrongBody = new Uint8Array([0, 255, 1, 129]);
    await run(function* () {
      let error: unknown;
      try {
        yield* store.putObject({
          objectId: "tampered-blob",
          lifetimeScope: "execution",
          scopeOwnerId: "one",
          objectKind: "artifact",
          contentHash: sha256Bytes(wrongBody),
          byteLength: body.byteLength,
          body,
          createdAt: 1,
        });
      } catch (cause) {
        error = cause;
      }
      expect(error).toMatchObject({ code: "persisted_data_invalid" });
    });
  });

  it("streams an immutable replay chain without rewriting prior segments", async () => {
    const store = createRedisExecutionStore(client, { keyPrefix });
    await run(function* () {
      const first = segment("replay-one", null, [{ outcome: "first" }]);
      const firstPointer = yield* store.appendReplaySegment(first);
      const second = segment("replay-two", firstPointer, [{ outcome: "second" }]);
      const secondPointer = yield* store.appendReplaySegment(second);
      const stream = yield* store.readReplay({
        executionId: "one",
        taskId: "root",
        head: secondPointer,
      });
      const values = yield* call(async () => {
        const result: Json[] = [];
        for await (const entries of stream) {
          result.push(...entries);
        }
        return result;
      });
      expect(values).toEqual([{ outcome: "first" }, { outcome: "second" }]);
    });
  });
});
