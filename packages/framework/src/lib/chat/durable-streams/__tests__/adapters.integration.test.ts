import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { run } from 'effection'
import { createClient, type RedisClientType } from 'redis'
import { Pool, type PoolClient } from 'pg'

import {
  createNodeRedisStoreAdapter,
  createPgStoreAdapter,
  createRedisBufferStore,
  createRedisRegistryStore,
  createPostgresBufferStore,
  createPostgresRegistryStore,
} from '../index.ts'

const redisUrl = process.env['REDIS_URL']
const pgConnectionString = process.env['PG_CONNECTION_STRING']

const describeRedis = redisUrl ? describe : describe.skip
const describePostgres = pgConnectionString ? describe : describe.skip

describeRedis('Redis durable-stream adapters (integration)', () => {
  let client: RedisClientType
  let subscriber: RedisClientType

  beforeAll(async () => {
    client = createClient({ url: redisUrl })
    subscriber = createClient({ url: redisUrl })
    await client.connect()
    await subscriber.connect()
  })

  afterAll(async () => {
    await subscriber.quit()
    await client.quit()
  })

  it('should persist buffer and registry state', async () => {
    const adapter = createNodeRedisStoreAdapter({ client, subscriber })
    const bufferStore = createRedisBufferStore<string>({
      adapter,
      serialize: (token) => token,
      deserialize: (token) => token,
      keyPrefix: `itest:${crypto.randomUUID()}`,
    })
    const registryStore = createRedisRegistryStore(
      adapter,
      `itest:${crypto.randomUUID()}`,
    )

    await run(function* () {
      const sessionId = `redis-${crypto.randomUUID()}`
      const buffer = yield* bufferStore.create(sessionId)

      yield* buffer.append(['hello'])
      const read1 = yield* buffer.read(0)
      expect(read1.tokens).toEqual(['hello'])
      expect(read1.lsn).toBe(1)

      yield* registryStore.set(sessionId, {
        refCount: 1,
        createdAt: Date.now(),
      })
      const entry = yield* registryStore.get(sessionId)
      expect(entry?.refCount).toBe(1)

      const updated = yield* registryStore.updateRefCount(sessionId, -1)
      expect(updated).toBe(0)
    })
  })
})

describePostgres('Postgres durable-stream adapters (integration)', () => {
  let pool: Pool
  let listener: PoolClient

  beforeAll(async () => {
    pool = new Pool({ connectionString: pgConnectionString })
    listener = await pool.connect()
  })

  afterAll(async () => {
    await listener.release()
    await pool.end()
  })

  it('should persist buffer and registry state', async () => {
    const adapter = createPgStoreAdapter({
      pool,
      listener,
      tableName: `durable_streams_kv_${Date.now()}`,
      channelPrefix: `durable_streams_${Date.now()}`,
    })

    const bufferStore = createPostgresBufferStore<string>({
      adapter,
      serialize: (token) => token,
      deserialize: (token) => token,
      keyPrefix: `itest:${crypto.randomUUID()}`,
    })

    const registryStore = createPostgresRegistryStore(
      adapter,
      `itest:${crypto.randomUUID()}`,
    )

    await run(function* () {
      const sessionId = `pg-${crypto.randomUUID()}`
      const buffer = yield* bufferStore.create(sessionId)

      yield* buffer.append(['hello'])
      const read1 = yield* buffer.read(0)
      expect(read1.tokens).toEqual(['hello'])
      expect(read1.lsn).toBe(1)

      yield* registryStore.set(sessionId, {
        refCount: 1,
        createdAt: Date.now(),
      })
      const entry = yield* registryStore.get(sessionId)
      expect(entry?.refCount).toBe(1)

      const updated = yield* registryStore.updateRefCount(sessionId, -1)
      expect(updated).toBe(0)
    })
  })
})
