import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { run } from "effection";
import { createClient, type RedisClientType } from "redis";

import {
  createCapabilityKeyring,
  type AttachProgramRequest,
  type DurableProgramManifest,
} from "@sweatpants/session-contract";

import { createRedisCrankStore, createRedisDurableJournalAuthority } from "../index.ts";

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
    if (client.isOpen) {
      await client.disconnect();
    }
  }
}

describe("RedisCrankStore", () => {
  let client: RedisClientType;
  let enabled = false;

  beforeAll(async () => {
    enabled = await available();
    if (!enabled) {
      return;
    }
    client = createClient({ url });
    await client.connect();
    await client.flushDb();
  });

  afterEach(async () => {
    if (enabled) {
      await client.flushDb();
    }
  });

  afterAll(async () => {
    if (enabled && client.isOpen) {
      await client.disconnect();
    }
  });

  function requireRedis(skip: (note?: string) => never): void {
    if (!enabled) {
      skip(`Redis unavailable at ${url}`);
    }
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

  it("persists atomic durable pull authorization and processless resolution", async ({ skip }) => {
    requireRedis(skip);
    const manifest: DurableProgramManifest = {
      programId: "redis.fixture",
      version: "1",
      digest: "a".repeat(64),
      inputSchema: { type: "null" },
      outputSchema: true,
      elicits: {},
      effects: {
        echo: {
          name: "echo",
          version: "1",
          inputSchema: true,
          outputSchema: true,
          retrySafety: { mode: "idempotent", mechanism: "pull_id_key" },
        },
      },
      capabilities: {
        durableEmissions: true,
        structuredChildren: true,
        replay: "strict",
      },
    };
    const keyring = createCapabilityKeyring("redis-test", [
      { keyId: "active", secret: "x".repeat(32) },
    ]);
    const first = createRedisDurableJournalAuthority(client, {
      journalId: "redis-journal",
      keyring,
      keyPrefix: "test:durable:",
    });
    const attach: AttachProgramRequest = {
      sessionId: "durable-session",
      taskId: "turn-0/root",
      program: { id: manifest.programId, version: manifest.version, digest: manifest.digest },
      input: null,
      route: { driverKind: "generator" },
      executionEpoch: 1,
    };
    await run(function* () {
      const opened = yield* first.openTask({
        sessionId: attach.sessionId,
        turnId: "turn-0",
        taskId: attach.taskId,
        manifest,
        input: null,
        executionEpoch: 1,
        attachmentId: "initial-attachment",
        audience: "program",
      });
      const reserved = yield* first.reserve({
        sessionId: attach.sessionId,
        turnId: "turn-0",
        taskId: attach.taskId,
        actionIndex: 0,
        pullIndex: 0,
        descriptor: {
          kind: "effect",
          name: "echo",
          version: "1",
          input: "value",
          resolver: { audience: "effect" },
        },
        programCapability: opened.programCapability,
      });
      if (reserved.status !== "authorized") {
        throw new Error("not authorized");
      }
      const second = createRedisDurableJournalAuthority(client, {
        journalId: "redis-journal",
        keyring,
        keyPrefix: "test:durable:",
      });
      expect(
        yield* second.resolve({
          capability: reserved.resolutionCapability,
          audience: "effect",
          outcome: { status: "ok", value: "value" },
        }),
      ).toMatchObject({ status: "accepted" });
      expect(yield* first.runnableSessions()).toEqual(["durable-session"]);
      expect(
        (yield* second.readJournal("durable-session")).map((record) => record.payload.type),
      ).toEqual(["TaskOpened", "PullRequested", "AttemptStarted", "PullResolved"]);
    });
  });

  it("persists deterministic child allocation across authority instances", async ({ skip }) => {
    requireRedis(skip);
    const keyring = createCapabilityKeyring("redis-child-test", [
      { keyId: "active", secret: "redis-child-test-secret-32-bytes" },
    ]);
    const parentManifest: DurableProgramManifest = {
      programId: "redis.parent",
      version: "1",
      digest: "1".repeat(64),
      inputSchema: { type: "null" },
      outputSchema: true,
      elicits: {},
      effects: {},
      capabilities: {
        durableEmissions: false,
        structuredChildren: true,
        replay: "strict",
      },
    };
    const childManifest: DurableProgramManifest = {
      programId: "redis.child",
      version: "1",
      digest: "2".repeat(64),
      inputSchema: { type: "object" },
      outputSchema: true,
      elicits: {},
      effects: {},
      capabilities: {
        durableEmissions: false,
        structuredChildren: false,
        replay: "strict",
      },
    };
    const first = createRedisDurableJournalAuthority(client, {
      journalId: "redis-child-journal",
      keyring,
      keyPrefix: "test:durable-child:",
    });
    await run(function* () {
      const opened = yield* first.openTask({
        sessionId: "child-session",
        turnId: "turn-0",
        taskId: "turn-0/root",
        manifest: parentManifest,
        input: null,
        executionEpoch: 1,
        attachmentId: "parent-attachment",
        audience: "program-runtime",
      });
      const child = {
        id: childManifest.programId,
        version: childManifest.version,
        digest: childManifest.digest,
        input: { value: 1 },
      };
      const reservation = yield* first.reserve({
        sessionId: "child-session",
        turnId: "turn-0",
        taskId: "turn-0/root",
        actionIndex: 0,
        pullIndex: 0,
        descriptor: { kind: "invoke", child },
        programCapability: opened.programCapability,
      });
      if (reservation.status !== "pending") {
        throw new Error("Child invocation did not park");
      }
      const allocated = yield* first.ensureChildTask({
        sessionId: "child-session",
        turnId: "turn-0",
        parentTaskId: "turn-0/root",
        parentPullId: reservation.pullId,
        child,
        manifest: childManifest,
        executionEpoch: 1,
        audience: "program-runtime",
      });
      expect(allocated.taskId).toBe("turn-0/root.0");

      const second = createRedisDurableJournalAuthority(client, {
        journalId: "redis-child-journal",
        keyring,
        keyPrefix: "test:durable-child:",
      });
      expect(
        yield* second.ensureChildTask({
          sessionId: "child-session",
          turnId: "turn-0",
          parentTaskId: "turn-0/root",
          parentPullId: reservation.pullId,
          child,
          manifest: childManifest,
          executionEpoch: 1,
          audience: "program-runtime",
        }),
      ).toEqual({ taskId: "turn-0/root.0" });
      expect(
        (yield* second.readJournal("child-session")).filter(
          (record) => record.payload.type === "TaskOpened",
        ),
      ).toHaveLength(2);
    });
  });

  it("fences stale owners and rediscovers expired running work", async ({ skip }) => {
    requireRedis(skip);
    let now = 0;
    const store = createRedisCrankStore(client, { keyPrefix: "test:crank:", now: () => now });
    await run(function* () {
      yield* store.appendCommand({ type: "send", sessionId: "s", commandId: "c", message: null });
      const first = yield* store.claim("s", "owner-a", 10);
      if ("status" in first) {
        throw new Error("claim failed");
      }
      expect(yield* store.claim("s", "owner-b", 10)).toEqual({ status: "busy" });
      now = 11;
      expect(yield* store.runnableSessions()).toContain("s");
      const second = yield* store.claim("s", "owner-b", 10);
      if ("status" in second) {
        throw new Error("failover failed");
      }
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
