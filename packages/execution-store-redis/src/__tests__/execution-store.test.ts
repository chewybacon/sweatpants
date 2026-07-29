import { all, call, run, type Operation } from "effection";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RedisClientType } from "redis";
import type { DurableReference, ExecutionTreeSnapshot } from "@sweatpants/durable-execution";

import { createRedisExecutionStore } from "../execution-store.ts";
import { cleanupRedisBackend, connectRedisBackend, type RedisBackend } from "./redis-backend.ts";

const keyPrefix = `test:${process.pid}:execution-store:`;
let backend: RedisBackend;
let client: RedisClientType;

function record(executionId: string): ExecutionTreeSnapshot {
  return {
    format: "sweatpants.execution-tree.v1",
    executionId,
    sessionId: `session:${executionId}`,
    turnId: `turn:${executionId}`,
    rootTaskId: "root",
    rootProgram: { id: "program", version: "1", digest: "digest" },
    tasks: [],
    runnableTaskIds: [],
    checkpoint: null,
    unpublishedProjection: { throughSequence: 0, facts: null },
  };
}

describe("Redis Execution Store v1", () => {
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

  it("CAS-isolates executions and atomically stores private records", async () => {
    const store = createRedisExecutionStore(client, { keyPrefix });
    await run(function* () {
      expect(
        yield* store.commitExecution({
          executionId: "one",
          expectedRevision: null,
          next: record("one"),
          privateRecords: [{ secret: "one" }],
        }),
      ).toEqual({ status: "accepted", revision: 0 });
      expect(
        yield* store.commitExecution({
          executionId: "two",
          expectedRevision: null,
          next: record("two"),
          privateRecords: [{ secret: "two" }],
        }),
      ).toEqual({ status: "accepted", revision: 0 });
      expect(
        yield* store.commitExecution({
          executionId: "one",
          expectedRevision: null,
          next: record("one"),
          privateRecords: [],
        }),
      ).toEqual({ status: "conflict", actualRevision: 0 });
      expect((yield* store.loadExecution("two"))?.record.executionId).toBe("two");
    });

    expect(await client.get(`${keyPrefix}execution:{one}:private:0`)).toBe('[{"secret":"one"}]');
    expect(await client.get(`${keyPrefix}execution:{two}:private:0`)).toBe('[{"secret":"two"}]');
  });

  it("lets exactly one concurrent writer win one expected revision", async () => {
    const store = createRedisExecutionStore(client, { keyPrefix });
    await run(function* () {
      expect(
        yield* store.commitExecution({
          executionId: "contended",
          expectedRevision: null,
          next: record("contended"),
          privateRecords: [],
        }),
      ).toEqual({ status: "accepted", revision: 0 });

      const results = yield* all([
        store.commitExecution({
          executionId: "contended",
          expectedRevision: 0,
          next: { ...record("contended"), turnId: "winner-a" },
          privateRecords: [],
        }),
        store.commitExecution({
          executionId: "contended",
          expectedRevision: 0,
          next: { ...record("contended"), turnId: "winner-b" },
          privateRecords: [],
        }),
      ]);
      expect(results.filter((result) => result.status === "accepted")).toHaveLength(1);
      expect(results.filter((result) => result.status === "conflict")).toHaveLength(1);
    });
  });

  it("round-trips content-addressed JSON and byte payloads", async () => {
    const store = createRedisExecutionStore(client, { keyPrefix });
    await run(function* () {
      const json = yield* store.putPayload({ nested: [true, null, "value"] });
      const jsonDuplicate = yield* store.putPayload({ nested: [true, null, "value"] });
      expect(jsonDuplicate).toEqual(json);
      expect(yield* store.getPayload(json)).toEqual({ nested: [true, null, "value"] });

      const bytes = yield* store.putPayload(new Uint8Array([0, 1, 254, 255]));
      expect(yield* store.getPayload(bytes)).toEqual(new Uint8Array([0, 1, 254, 255]));
      expect(
        yield* store.getPayload({
          id: "payload:missing",
          integrity: { algorithm: "sha256", value: "0".repeat(64) },
        }),
      ).toBeNull();
    });
  });

  it("appends an immutable replay chain without rewriting prior objects", async () => {
    const store = createRedisExecutionStore(client, { keyPrefix });
    await run(function* () {
      const first = yield* store.appendReplay({
        executionId: "replay",
        taskId: "root",
        previous: null,
        entries: [{ outcome: "first" }],
      });
      const firstRaw = yield* getRaw(first);
      const second = yield* store.appendReplay({
        executionId: "replay",
        taskId: "root",
        previous: first,
        entries: [{ outcome: "second" }],
      });

      expect(yield* store.readReplay(first)).toEqual([{ outcome: "first" }]);
      expect(yield* store.readReplay(second)).toEqual([
        { outcome: "first" },
        { outcome: "second" },
      ]);
      expect(yield* getRaw(first)).toBe(firstRaw);
    });

    function* getRaw(reference: DurableReference): Operation<string | null> {
      return yield* call(() => client.get(`${keyPrefix}${reference.id}`));
    }
  });

  it("creates no obsolete journal-wide snapshot key", async () => {
    const keys = await client.keys(`${keyPrefix}*`);
    expect(keys.some((key) => key.includes(["durable", "authority:"].join("-")))).toBe(false);
    expect(keys.some((key) => key.includes(":control"))).toBe(true);
    expect(keys.some((key) => key.includes("payload:"))).toBe(true);
    expect(keys.some((key) => key.includes("replay:"))).toBe(true);
  });
});
