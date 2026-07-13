import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { run } from "effection";
import { createClient, type RedisClientType } from "redis";

import { createRedisCrankStore } from "../index.ts";

const url = process.env["REDIS_URL"] ?? "redis://localhost:6379";

async function available(): Promise<boolean> {
  const client = createClient({ url });
  try {
    await client.connect();
    await client.ping();
    return true;
  } catch {
    return false;
  } finally {
    if (client.isOpen) await client.disconnect();
  }
}

describe("RedisCrankStore", () => {
  let client: RedisClientType;
  let enabled = false;

  beforeAll(async () => {
    enabled = await available();
    if (!enabled) return;
    client = createClient({ url });
    await client.connect();
    await client.flushDb();
  });

  afterEach(async () => {
    if (enabled) await client.flushDb();
  });

  afterAll(async () => {
    if (enabled && client.isOpen) await client.disconnect();
  });

  function requireRedis(skip: (note?: string) => never): void {
    if (!enabled) skip(`Redis unavailable at ${url}`);
  }

  it("persists commands across independent store instances", async ({ skip }) => {
    requireRedis(skip);
    const first = createRedisCrankStore(client, { keyPrefix: "test:crank:" });
    await run(function* () {
      yield* first.appendCommand({
        type: "send",
        sessionId: "s",
        commandId: "c",
        message: "hello",
      });
    });
    const second = createRedisCrankStore(client, { keyPrefix: "test:crank:" });
    const records = await run(() => second.readJournal("s"));
    expect(records).toHaveLength(1);
    expect(records[0]?.payload).toMatchObject({ type: "command", command: { commandId: "c" } });
  });

  it("fences stale owners and rediscovers expired running work", async ({ skip }) => {
    requireRedis(skip);
    let now = 0;
    const store = createRedisCrankStore(client, { keyPrefix: "test:crank:", now: () => now });
    await run(function* () {
      yield* store.appendCommand({ type: "send", sessionId: "s", commandId: "c", message: null });
      const first = yield* store.claim("s", "owner-a", 10);
      if ("status" in first) throw new Error("claim failed");
      expect(yield* store.claim("s", "owner-b", 10)).toEqual({ status: "busy" });
      now = 11;
      expect(yield* store.runnableSessions()).toContain("s");
      const second = yield* store.claim("s", "owner-b", 10);
      if ("status" in second) throw new Error("failover failed");
      expect(second.epoch).toBeGreaterThan(first.epoch);
      expect(
        yield* store.appendExecution(first, 1, {
          type: "turn_opened",
          turnId: "turn-0",
          turnSeq: 0,
          taskId: "turn-0/root",
          commandId: "c",
          programVersion: "v1",
          input: null,
          inputSha: "unused",
        }),
      ).toEqual({ status: "fenced" });
    });
  });
});
