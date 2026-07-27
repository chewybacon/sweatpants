import { afterAll, beforeAll, describe, it } from "vitest";
import type { RedisClientType } from "redis";
import { run } from "effection";

import {
  createJournalAuthorityConformanceCases,
  type JournalAuthorityConformanceFactory,
} from "@sweatpants/session-contract/testing";

import { createRedisDurableJournalAuthority } from "../durable-authority.ts";
import { cleanupRedisBackend, connectRedisBackend, type RedisBackend } from "./redis-backend.ts";

let backend: RedisBackend;
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
      now: options.now,
      schemaRegistry: options.schemaRegistry,
    });
  },
};

describe("JournalAuthority Redis conformance", () => {
  beforeAll(async () => {
    backend = await connectRedisBackend();
    client = backend.client;
  });

  afterAll(async () => {
    await cleanupRedisBackend(backend, authorityKeyPrefix);
  });

  // Names the backend in the output so a green run against the in-memory command
  // surface is never mistaken for certification of Redis semantics.
  it("reports which backend certified this run", () => {
    console.info(`[journal-authority-redis] conformance backend: ${backend.label}`);
  });

  for (const conformanceCase of createJournalAuthorityConformanceCases(factory)) {
    it(conformanceCase.name, async () => {
      await run(() => conformanceCase.run());
    });
  }
});
