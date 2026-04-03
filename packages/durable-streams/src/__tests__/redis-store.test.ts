import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { run } from 'effection'
import { createClient, type RedisClientType } from 'redis'

import { createRedisTokenBufferStore } from '../redis-store.ts'
import type { TokenBuffer } from '../types.ts'

function redisUrl(): string {
  return process.env['REDIS_URL'] ?? 'redis://localhost:6379'
}

async function isRedisAvailable(): Promise<boolean> {
  try {
    const client = createClient({ url: redisUrl() })
    await client.connect()
    await client.ping()
    await client.disconnect()
    return true
  } catch {
    return false
  }
}

describe('RedisTokenBufferStore', () => {
  let client: RedisClientType
  let redisAvailable = false

  beforeAll(async () => {
    redisAvailable = await isRedisAvailable()
    if (!redisAvailable) {
      return
    }
    client = createClient({ url: redisUrl() })
    await client.connect()
    await client.flushDb()
  })

  afterEach(async () => {
    if (redisAvailable) {
      await client.flushDb()
    }
  })

  it('creates a buffer', async () => {
    if (!redisAvailable) {
      return
    }

    const store = createRedisTokenBufferStore<string>(client)
    const buffer = await run(() => store.create('test-stream'))
    expect(buffer.id).toBe('test-stream')
  })

  it('appends and reads tokens', async () => {
    if (!redisAvailable) {
      return
    }

    const store = createRedisTokenBufferStore<string>(client)
    const buffer = await run(() => store.create('append-read'))

    const lsn = await run(() => buffer.append(['a', 'b', 'c']))
    expect(lsn).toBe(2)

    const result = await run(() => buffer.read(0))
    expect(result.tokens).toEqual(['a', 'b', 'c'])
    expect(result.lsn).toBe(2)
  })

  it('reads from a specific offset', async () => {
    if (!redisAvailable) {
      return
    }

    const store = createRedisTokenBufferStore<string>(client)
    const buffer = await run(() => store.create('offset-read'))

    await run(() => buffer.append(['a', 'b', 'c', 'd']))

    const result = await run(() => buffer.read(2))
    expect(result.tokens).toEqual(['c', 'd'])
    expect(result.lsn).toBe(3)
  })

  it('returns empty tokens when reading past tail', async () => {
    if (!redisAvailable) {
      return
    }

    const store = createRedisTokenBufferStore<string>(client)
    const buffer = await run(() => store.create('past-tail'))

    await run(() => buffer.append(['a']))

    const result = await run(() => buffer.read(10))
    expect(result.tokens).toEqual([])
    expect(result.lsn).toBe(0)
  })

  it('completes the buffer', async () => {
    if (!redisAvailable) {
      return
    }

    const store = createRedisTokenBufferStore<string>(client)
    const buffer = await run(() => store.create('complete'))

    await run(() => buffer.complete())
    const isComplete = await run(() => buffer.isComplete())
    expect(isComplete).toBe(true)
  })

  it('fails the buffer with an error', async () => {
    if (!redisAvailable) {
      return
    }

    const store = createRedisTokenBufferStore<string>(client)
    const buffer = await run(() => store.create('fail'))

    const err = new Error('boom')
    await run(() => buffer.fail(err))
    const error = await run(() => buffer.getError())
    expect(error?.message).toBe('boom')
  })

  it('gets a buffer by id', async () => {
    if (!redisAvailable) {
      return
    }

    const store = createRedisTokenBufferStore<string>(client)
    await run(() => store.create('get-by-id'))

    const buffer = await run(() => store.get('get-by-id'))
    expect(buffer).not.toBeNull()
    expect(buffer?.id).toBe('get-by-id')
  })

  it('returns null for non-existent buffer', async () => {
    if (!redisAvailable) {
      return
    }

    const store = createRedisTokenBufferStore<string>(client)
    const buffer = await run(() => store.get('non-existent'))
    expect(buffer).toBeNull()
  })

  it('deletes a buffer', async () => {
    if (!redisAvailable) {
      return
    }

    const store = createRedisTokenBufferStore<string>(client)
    await run(() => store.create('to-delete'))

    await run(() => store.delete('to-delete'))
    const buffer = await run(() => store.get('to-delete'))
    expect(buffer).toBeNull()
  })

  it('waits for change when new data arrives', async () => {
    if (!redisAvailable) {
      return
    }

    const store = createRedisTokenBufferStore<string>(client)
    const buffer = await run(() => store.create('wait-change'))

    await run(() => buffer.append(['a']))

    const waitForChangePromise = run(() => buffer.waitForChange(0))

    await new Promise((resolve) => setTimeout(resolve, 50))

    await run(() => buffer.append(['b']))

    await waitForChangePromise

    const result = await run(() => buffer.read(1))
    expect(result.tokens).toEqual(['b'])
  })
}, 30_000)
