import { afterAll, beforeAll, describe, it } from "vitest";
import { run } from "effection";
import type { RedisClientType } from "redis";

import {
  createDurableSandboxConformanceCases,
  type DurableSandboxConformanceFactory,
} from "@sweatpants/workspace-runtime/testing";

import { createRedisExecutionStore } from "../execution-store.ts";
import { createStoredScenarioDriver } from "@sweatpants/journal-authority/testing";
import { cleanupRedisBackend, connectRedisBackend, type RedisBackend } from "./redis-backend.ts";

const authorityKeyPrefix = `test:${process.pid}:sandbox-conformance:`;
let backend: RedisBackend;
let client: RedisClientType;

const factory: DurableSandboxConformanceFactory = {
  backendName: "redis",
  *open(options) {
    return createStoredScenarioDriver(
      createRedisExecutionStore(client, { keyPrefix: authorityKeyPrefix }),
      {
        journalId: options.journalId,
        journalIncarnation: "sandbox-conformance-v1",
        keyring: options.keyring,
        now: () => 1_000,
      },
    );
  },
};

describe("durable sandbox Redis conformance", () => {
  beforeAll(async () => {
    // This suite previously named Redis but always constructed the in-memory
    // command surface, so it could not observe a Redis regression at all.
    backend = await connectRedisBackend();
    client = backend.client;
  });

  afterAll(async () => {
    await cleanupRedisBackend(backend, authorityKeyPrefix);
  });

  it("reports which backend certified this run", () => {
    console.info(`[execution-store-redis] sandbox backend: ${backend.label}`);
  });

  for (const conformanceCase of createDurableSandboxConformanceCases(factory)) {
    it(conformanceCase.name, async () => {
      await run(() => conformanceCase.run());
    });
  }
});
