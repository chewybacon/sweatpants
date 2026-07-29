import { createClient, type RedisClientType } from "redis";

import { createMemoryRedisClient } from "./memory-redis.ts";

/**
 * How a Redis-backed suite obtained its client.
 *
 * The distinction is load-bearing: a suite running against the in-memory
 * command surface proves the calling code is well-formed, but proves nothing
 * about Redis semantics — expiry, atomicity, or cross-connection visibility.
 */
export type RedisBackendKind = "redis" | "memory-fake";

export interface RedisBackend {
  readonly client: RedisClientType;
  readonly kind: RedisBackendKind;
  /** Suffix for the suite name so test output never misreports coverage. */
  readonly label: string;
}

/**
 * True when the caller has asked for real Redis specifically, rather than
 * accepting whatever is available.
 *
 * Setting `REDIS_URL` is taken as that request: naming an instance and then
 * silently testing something else is the failure mode this guards.
 */
function realRedisRequired(): boolean {
  return process.env["REDIS_URL"] !== undefined || process.env["REDIS_REQUIRED"] === "1";
}

/**
 * Connects a Redis client, falling back to the in-memory command surface only
 * when real Redis was not explicitly requested.
 *
 * Previously every Redis suite fell back silently, so a bogus `REDIS_URL`
 * still reported a full green run. That made the strongest gate over the
 * storage layer unable to fail, which matters most precisely when the storage
 * layer is being rewritten.
 */
export async function connectRedisBackend(): Promise<RedisBackend> {
  const url = process.env["REDIS_URL"] ?? "redis://localhost:6379";
  const candidate = createClient({ url });
  try {
    await candidate.connect();
    await candidate.ping();
    return { client: candidate as RedisClientType, kind: "redis", label: "redis" };
  } catch (error) {
    if (candidate.isOpen) {
      await candidate.disconnect();
    }
    if (realRedisRequired()) {
      throw new Error(
        `Real Redis was required but ${url} is unreachable: ${(error as Error).message}. ` +
          `Start one (docker start sweatpants-redis) or unset REDIS_URL/REDIS_REQUIRED to run ` +
          `against the in-memory command surface, which does not certify Redis semantics.`,
      );
    }
    return {
      client: createMemoryRedisClient(),
      kind: "memory-fake",
      label: "memory-fake (NOT Redis semantics)",
    };
  }
}

/** Deletes every key this suite created, when the backend supports scanning. */
export async function cleanupRedisBackend(backend: RedisBackend, keyPrefix: string): Promise<void> {
  const { client } = backend;
  if (!client.isOpen) {
    return;
  }
  const keys = await client.keys(`${keyPrefix}*`);
  if (keys.length > 0) {
    await client.del(keys);
  }
  await client.disconnect();
}
