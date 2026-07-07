import { createRedisTokenBufferStore } from '@sweatpants/durable-streams/redis'
import type { RedisClientType } from 'redis'

import type { LogRecord, TokenBufferStore } from '@sweatpants/session-contract'

/**
 * Options for {@link createRedisSessionStore}.
 */
export interface CreateRedisSessionStoreOptions {
  /**
   * A connected Redis client. The store will `duplicate()` it internally to
   * create a dedicated subscriber connection for cross-process `waitForChange`
   * (REQ-063).
   */
  client: RedisClientType
  /** Key prefix for Redis stream + meta hashes. */
  keyPrefix?: string
}

/**
 * Creates a Redis-backed `TokenBufferStore<LogRecord>` for session-contract
 * sessions, using the durable-streams Redis `TokenBufferStore` implementation.
 *
 * This enables production durability for AgentCore tool sessions: sessions
 * persist across process restarts, pending `elicit` waits are answerable with
 * the same token after restore, and cross-process live notification works via
 * Redis pub/sub (REQ-062, REQ-063).
 *
 * The Redis import is direct from `@sweatpants/durable-streams/redis` at this
 * consumer site, not from `@sweatpants/session-contract` root (REQ-060,
 * NFR-012).
 */
export function createRedisSessionStore(
  options: CreateRedisSessionStoreOptions,
): TokenBufferStore<LogRecord> {
  return createRedisTokenBufferStore<LogRecord>(options.client, {
    keyPrefix: options.keyPrefix ?? 'sc:session:',
  })
}
