import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { run } from "effection";
import { createClient, type RedisClientType } from "redis";
import { appendTestTokens, completeTestBuffer, failTestBuffer } from "./test-writer.ts";

import { createRedisTokenBufferStore } from "../redis-store.ts";
import { defineTokenBufferStoreConformance } from "./token-buffer-store-conformance.ts";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const packageRoot = resolve(process.cwd());

function redisUrl(): string {
  return process.env["REDIS_URL"] ?? "redis://localhost:6379";
}

async function isRedisAvailable(): Promise<boolean> {
  try {
    const client = createClient({ url: redisUrl() });
    await client.connect();
    await client.ping();
    await client.disconnect();
    return true;
  } catch {
    return false;
  }
}

describe("RedisTokenBufferStore", () => {
  let client: RedisClientType;
  let redisAvailable = false;

  beforeAll(async () => {
    redisAvailable = await isRedisAvailable();
    if (!redisAvailable) {
      return;
    }
    client = createClient({ url: redisUrl() });
    await client.connect();
    await client.flushDb();
  });

  afterEach(async () => {
    if (redisAvailable) {
      await client.flushDb();
    }
  });

  afterAll(async () => {
    if (redisAvailable) {
      await client.disconnect();
    }
  });

  const requireRedis = (skip: (note?: string) => never): void => {
    if (!redisAvailable) {
      skip(`Redis unavailable at ${redisUrl()}`);
    }
  };

  defineTokenBufferStoreConformance(
    "redis",
    () => createRedisTokenBufferStore<string>(client),
    requireRedis,
  );

  it("creates a buffer", async ({ skip }) => {
    requireRedis(skip);

    const store = createRedisTokenBufferStore<string>(client);
    const buffer = await run(() => store.create("test-stream"));
    expect(buffer.id).toBe("test-stream");
  });

  it("appends and reads tokens", async ({ skip }) => {
    requireRedis(skip);

    const store = createRedisTokenBufferStore<string>(client);
    const buffer = await run(() => store.create("append-read"));

    const lsn = await run(() => appendTestTokens(buffer, ["a", "b", "c"]));
    expect(lsn).toBe(3);

    const result = await run(() => buffer.read(0));
    expect(result.tokens).toEqual(["a", "b", "c"]);
    expect(result.lsn).toBe(3);
  });

  it("reads from a specific offset", async ({ skip }) => {
    requireRedis(skip);

    const store = createRedisTokenBufferStore<string>(client);
    const buffer = await run(() => store.create("offset-read"));

    await run(() => appendTestTokens(buffer, ["a", "b", "c", "d"]));

    const result = await run(() => buffer.read(2));
    expect(result.tokens).toEqual(["c", "d"]);
    expect(result.lsn).toBe(4);
  });

  it("returns empty tokens when reading past tail", async ({ skip }) => {
    requireRedis(skip);

    const store = createRedisTokenBufferStore<string>(client);
    const buffer = await run(() => store.create("past-tail"));

    await run(() => appendTestTokens(buffer, ["a"]));

    const result = await run(() => buffer.read(10));
    expect(result.tokens).toEqual([]);
    expect(result.lsn).toBe(1);
  });

  it("seeks directly to the reconnect LSN with a bounded Redis query", async ({ skip }) => {
    requireRedis(skip);
    const store = createRedisTokenBufferStore<string>(client);
    const buffer = await run(() => store.create("bounded-reconnect"));
    await run(() =>
      appendTestTokens(
        buffer,
        Array.from({ length: 1_000 }, (_, i) => String(i)),
      ),
    );
    const reconnected = await run(() => store.get(buffer.id));
    expect(reconnected).not.toBeNull();
    const query = vi.spyOn(client, "xRange");
    try {
      expect(await run(() => reconnected!.read(990, 3))).toEqual({
        tokens: ["990", "991", "992"],
        lsn: 1_000,
      });
      expect(query).toHaveBeenCalledExactlyOnceWith(
        "durable-stream:bounded-reconnect:stream",
        "(990-0",
        "1000-0",
        { COUNT: 3 },
      );
    } finally {
      query.mockRestore();
    }
  });

  it("requires an explicit reset of buffers using an unsupported storage format", async ({
    skip,
  }) => {
    requireRedis(skip);
    const store = createRedisTokenBufferStore<string>(client);
    await run(() => store.create("old-format"));
    await client.hDel("durable-stream:old-format:meta", "format");
    await expect(run(() => store.get("old-format"))).rejects.toThrow(
      "Reset Redis keys durable-stream:old-format:*",
    );
  });

  it("completes the buffer", async ({ skip }) => {
    requireRedis(skip);

    const store = createRedisTokenBufferStore<string>(client);
    const buffer = await run(() => store.create("complete"));

    await run(() => completeTestBuffer(buffer));
    const isComplete = await run(() => buffer.isComplete());
    expect(isComplete).toBe(true);
  });

  it("fails the buffer with an error", async ({ skip }) => {
    requireRedis(skip);

    const store = createRedisTokenBufferStore<string>(client);
    const buffer = await run(() => store.create("fail"));

    const err = new Error("boom");
    await run(() => failTestBuffer(buffer, err));
    const error = await run(() => buffer.getError());
    expect(error?.message).toBe("boom");
  });

  it("gets a buffer by id", async ({ skip }) => {
    requireRedis(skip);

    const store = createRedisTokenBufferStore<string>(client);
    await run(() => store.create("get-by-id"));

    const buffer = await run(() => store.get("get-by-id"));
    expect(buffer).not.toBeNull();
    expect(buffer?.id).toBe("get-by-id");
  });

  it("returns null for non-existent buffer", async ({ skip }) => {
    requireRedis(skip);

    const store = createRedisTokenBufferStore<string>(client);
    const buffer = await run(() => store.get("non-existent"));
    expect(buffer).toBeNull();
  });

  it("deletes a buffer", async ({ skip }) => {
    requireRedis(skip);

    const store = createRedisTokenBufferStore<string>(client);
    await run(() => store.create("to-delete"));

    await run(() => store.delete("to-delete"));
    const buffer = await run(() => store.get("to-delete"));
    expect(buffer).toBeNull();
  });

  it("waits for change when new data arrives", async ({ skip }) => {
    requireRedis(skip);

    const store = createRedisTokenBufferStore<string>(client);
    const buffer = await run(() => store.create("wait-change"));

    await run(() => appendTestTokens(buffer, ["a"]));

    const waitForChangePromise = run(() => buffer.waitForChange(1));

    await new Promise((resolve) => setTimeout(resolve, 50));

    await run(() => appendTestTokens(buffer, ["b"]));

    await waitForChangePromise;

    const result = await run(() => buffer.read(1));
    expect(result.tokens).toEqual(["b"]);
  });

  // REQ-064: append MUST use XLEN (O(1)) for the token count, not xRange
  // (O(n) over the full stream). This is a static source check that runs
  // without a Redis instance.
  it("uses XLEN for append count, not xRange (REQ-064)", () => {
    const source = readFileSync(resolve(packageRoot, "src/redis-store.ts"), "utf8");
    // Extract the append method body
    const appendMatches = [
      ...source.matchAll(/\*append\(tokens\)[\s\S]*?(?=\n\s*\*complete\(\))/g),
    ];
    expect(appendMatches.length, "append methods should be found in source").toBeGreaterThan(0);
    const appendBody = appendMatches.map((match) => match[0]).join("\n");
    // XLEN should be used for counting, either through the client or an atomic Lua mutation.
    expect(appendBody.toLowerCase()).toContain("xlen");
    // xRange should NOT be called in the append method body
    expect(appendBody).not.toContain("xRange");
  });
}, 30_000);
