import { afterAll, beforeAll, describe, it } from "vitest";
import type { RedisClientType } from "redis";
import { run } from "effection";

import {
  createJournalAuthorityConformanceCases,
  type JournalAuthorityConformanceFactory,
} from "@sweatpants/journal-authority/testing";

import { createRedisExecutionStore } from "../execution-store.ts";
import { createStoredDurableJournalAuthority } from "@sweatpants/journal-authority";
import { cleanupRedisBackend, connectRedisBackend, type RedisBackend } from "./redis-backend.ts";

let backend: RedisBackend;
const authorityKeyPrefix = `test:${process.pid}:authority-conformance:`;
let client: RedisClientType;

const factory: JournalAuthorityConformanceFactory = {
  backendName: "redis",
  *open(options) {
    return createStoredDurableJournalAuthority(
      createRedisExecutionStore(client, { keyPrefix: authorityKeyPrefix }),
      {
        journalId: options.journalId,
        journalIncarnation: "conformance-v1",
        keyring: options.keyring,
        now: options.now,
        schemaRegistry: options.schemaRegistry,
      },
    );
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
    console.info(`[execution-store-redis] conformance backend: ${backend.label}`);
  });

  for (const conformanceCase of createJournalAuthorityConformanceCases(factory)) {
    it(conformanceCase.name, async () => {
      await run(() => conformanceCase.run());
    });
  }
});
