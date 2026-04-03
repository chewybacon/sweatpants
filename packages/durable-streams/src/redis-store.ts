import { createSignal, each, call, type Signal } from 'effection'
import type { RedisClientType } from 'redis'

import type { TokenBuffer, TokenBufferStore } from './types.ts'

interface StreamEntry {
  id: string
  message: Record<string, string>
}

export type RedisTokenBufferStore<T> = TokenBufferStore<T>

export interface RedisBufferOptions {
  keyPrefix?: string
  flushOnRead?: boolean
}

export function createRedisTokenBufferStore<T>(
  client: RedisClientType,
  options: RedisBufferOptions = {},
): RedisTokenBufferStore<T> {
  const { keyPrefix = 'durable-stream:', flushOnRead = false } = options
  const streamKey = (id: string): string => `${keyPrefix}${id}:stream`
  const metaKey = (id: string): string => `${keyPrefix}${id}:meta`

  const signals = new Map<string, Signal<void, void>>()

  const getSignal = (id: string): Signal<void, void> => {
    let signal = signals.get(id)
    if (!signal) {
      signal = createSignal<void, void>()
      signals.set(id, signal)
    }
    return signal
  }

  const parseEntry = (entry: StreamEntry): T => {
    const token = entry.message['token']
    if (token === undefined) {
      throw new Error('Missing token field in stream entry')
    }
    return JSON.parse(token) as T
  }

  const serializeToken = (token: T): string => {
    return JSON.stringify(token)
  }

  return {
    *create(id) {
      const key = streamKey(id)
      const exists = yield* call(() => client.exists(key))
      if (exists) {
        throw new Error(`Buffer ${id} already exists`)
      }

      const initId = yield* call(() => client.xAdd(key, '*', { token: serializeToken('__init__' as unknown as T) }))
      yield* call(() => client.xDel(key, initId))

      yield* call(() =>
        client.hSet(metaKey(id), {
          id,
          createdAt: Date.now().toString(),
          completed: 'false',
          error: '',
          refCount: '0',
          flushedUpTo: '-1',
        }),
      )

      return createRedisBuffer(id, client, streamKey, metaKey, getSignal, parseEntry, serializeToken, flushOnRead)
    },

    *get(id) {
      const key = streamKey(id)
      const exists = yield* call(() => client.exists(key))
      if (!exists) {
        return null
      }
      return createRedisBuffer(id, client, streamKey, metaKey, getSignal, parseEntry, serializeToken, flushOnRead)
    },

    *delete(id) {
      yield* call(() => client.del(streamKey(id)))
      yield* call(() => client.del(metaKey(id)))
      signals.delete(id)
    },
  }
}

function createRedisBuffer<T>(
  id: string,
  client: RedisClientType,
  streamKey: (id: string) => string,
  metaKey: (id: string) => string,
  getSignal: (id: string) => Signal<void, void>,
  parseEntry: (entry: StreamEntry) => T,
  serializeToken: (token: T) => string,
  flushOnRead: boolean,
): TokenBuffer<T> {
  return {
    id,

    *append(tokens) {
      const key = streamKey(id)
      for (const token of tokens) {
        yield* call(() => client.xAdd(key, '*', { token: serializeToken(token) }))
      }
      const allEntries = yield* call(() => client.xRange(key, '-', '+'))
      const count = allEntries.length - 1
      const signal = getSignal(id)
      signal.send()
      return count
    },

    *complete() {
      yield* call(() => client.hSet(metaKey(id), { completed: 'true' }))
      const signal = getSignal(id)
      signal.send()
    },

    *fail(error) {
      yield* call(() =>
        client.hSet(metaKey(id), {
          completed: 'true',
          error: error.message,
        }),
      )
      const signal = getSignal(id)
      signal.send()
    },

    *read(afterLSN = 0) {
      const key = streamKey(id)
      const entries = yield* call(() => client.xRange(key, '-', '+'))

      const allTokens: T[] = []
      for (const entry of entries) {
        const parsed = parseEntry({ id: entry.id, message: entry.message })
        if (parsed !== '__init__') {
          allTokens.push(parsed)
        }
      }

      const tokens = allTokens.slice(afterLSN)

      if (flushOnRead && tokens.length > 0) {
        yield* call(() => client.hSet(metaKey(id), { flushedUpTo: String(afterLSN + tokens.length - 1) }))
      }

      return { tokens, lsn: allTokens.length - 1 }
    },

    *isComplete() {
      const completed = yield* call(() => client.hGet(metaKey(id), 'completed'))
      return completed === 'true'
    },

    *getError() {
      const error = yield* call(() => client.hGet(metaKey(id), 'error'))
      if (error) {
        return new Error(error)
      }
      return null
    },

    *waitForChange(afterLSN) {
      const key = streamKey(id)
      const entries = yield* call(() => client.xRange(key, '-', '+'))
      const currentCount = entries.length - 1
      if (currentCount > afterLSN) {
        return
      }

      const completed = yield* call(() => client.hGet(metaKey(id), 'completed'))
      if (completed === 'true') {
        return
      }

      const signal = getSignal(id)
      for (const _ of yield* each(signal)) {
        break
      }
    },
  }
}
