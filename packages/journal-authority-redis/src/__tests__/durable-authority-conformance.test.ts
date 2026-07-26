import { afterAll, beforeAll, describe, it } from "vitest";
import { createClient, type RedisClientType } from "redis";
import { run } from "effection";

import {
  createJournalAuthorityConformanceCases,
  type JournalAuthorityConformanceFactory,
} from "@sweatpants/session-contract/testing";

import { createRedisDurableJournalAuthority } from "../durable-authority.ts";
import { createMemoryRedisClient } from "./memory-redis.ts";

const redisUrl = process.env["REDIS_URL"] ?? "redis://localhost:6379";
const authorityKeyPrefix = `test:${process.pid}:authority-conformance:`;
let client: RedisClientType;

const factory: JournalAuthorityConformanceFactory = {
  backendName: "redis",
  *open(options) {
    return createRedisDurableJournalAuthority(client, {
      journalId: options.journalId,
      journalIncarnation: "conformance-v1",
      keyPrefix: authorityKeyPrefix,
      keyring: options.keyring,
      now: () => 1_000,
      schemaRegistry: options.schemaRegistry,
    });
  },
};

async function connectRedis(): Promise<RedisClientType> {
  const candidate = createClient({ url: redisUrl });
  try {
    await candidate.connect();
    await candidate.ping();
    return candidate;
  } catch {
    if (candidate.isOpen) {
      await candidate.disconnect();
    }
    return createMemoryRedisClient();
  }
}

describe("JournalAuthority Redis conformance", () => {
  beforeAll(async () => {
    client = await connectRedis();
  });

  afterAll(async () => {
    if (client.isOpen) {
      const keys = await client.keys(`${authorityKeyPrefix}*`);
      if (keys.length > 0) {
        await client.del(keys);
      }
      await client.disconnect();
    }
  });

  for (const conformanceCase of createJournalAuthorityConformanceCases(factory)) {
    it(conformanceCase.name, async () => {
      await run(() => conformanceCase.run());
    });
  }
});
