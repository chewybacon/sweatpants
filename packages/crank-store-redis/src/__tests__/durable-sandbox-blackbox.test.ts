import { afterAll, beforeAll, describe, it } from "vitest";
import { run } from "effection";
import type { RedisClientType } from "redis";

import {
  createDurableSandboxConformanceCases,
  type DurableSandboxConformanceFactory,
} from "@sweatpants/session-contract/testing";

import { createRedisDurableJournalAuthority } from "../durable-authority.ts";
import { createMemoryRedisClient } from "./memory-redis.ts";

const authorityKeyPrefix = `test:${process.pid}:sandbox-conformance:`;
let client: RedisClientType;

const factory: DurableSandboxConformanceFactory = {
  backendName: "redis",
  *open(options) {
    return createRedisDurableJournalAuthority(client, {
      journalId: options.journalId,
      journalIncarnation: "sandbox-conformance-v1",
      keyPrefix: authorityKeyPrefix,
      keyring: options.keyring,
      now: () => 1_000,
    });
  },
};

describe("durable sandbox Redis conformance", () => {
  beforeAll(() => {
    client = createMemoryRedisClient();
  });

  afterAll(async () => {
    if (client.isOpen) {
      await client.disconnect();
    }
  });

  for (const conformanceCase of createDurableSandboxConformanceCases(factory)) {
    it(conformanceCase.name, async () => {
      await run(() => conformanceCase.run());
    });
  }
});
