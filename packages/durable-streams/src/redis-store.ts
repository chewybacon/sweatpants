import { createSignal, spawn, call, type Signal } from 'effection'
import type { Operation } from 'effection'
import type { RedisClientType } from 'redis'

import { StaleTokenWriterError } from './types.ts'
import type { TokenBuffer, TokenBufferStore, TokenBufferWriter } from './types.ts'

interface StreamEntry {
  id: string
  message: Record<string, string>
}

function luaFencedWriterGuard(keyIndex: 1 | 2, failureCode: 0 | -1): string {
  return `
if redis.call('HGET', KEYS[${keyIndex}], 'writerOwner') ~= ARGV[1] or
   redis.call('HGET', KEYS[${keyIndex}], 'writerEpoch') ~= ARGV[2] then return ${failureCode} end
`
}

export type RedisTokenBufferStore<T> = TokenBufferStore<T>

export interface RedisBufferOptions {
  keyPrefix?: string
  flushOnRead?: boolean
}

/**
 * Creates a Redis-backed `TokenBufferStore`.
 *
 * Cross-process notification (REQ-063): the writer `PUBLISH`es to a per-buffer
 * channel after each `append`, `complete`, and `fail`. Readers in other
 * processes subscribe to that channel in `waitForChange` so they wake when a
 * remote process mutates the buffer. The in-process `Signal` is retained as a
 * same-process fast path.
 *
 * The `subscriberClient` is an optional dedicated subscriber connection. If
 * omitted, a duplicate of `client` is created lazily on first `waitForChange`.
 * Redis requires a separate connection for pub/sub subscription.
 */
export function createRedisTokenBufferStore<T>(
  client: RedisClientType,
  options: RedisBufferOptions = {},
): RedisTokenBufferStore<T> {
  const { keyPrefix = 'durable-stream:', flushOnRead = false } = options
  const streamKey = (id: string): string => `${keyPrefix}${id}:stream`
  const metaKey = (id: string): string => `${keyPrefix}${id}:meta`
  const changeChannel = (id: string): string => `${keyPrefix}${id}:change`

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
          flushedUpTo: '0',
        }),
      )

      return createRedisBuffer(id, client, streamKey, metaKey, changeChannel, getSignal, parseEntry, serializeToken, flushOnRead)
    },

    *get(id) {
      const key = streamKey(id)
      const exists = yield* call(() => client.exists(key))
      if (!exists) {
        return null
      }
      return createRedisBuffer(id, client, streamKey, metaKey, changeChannel, getSignal, parseEntry, serializeToken, flushOnRead)
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
  changeChannel: (id: string) => string,
  getSignal: (id: string) => Signal<void, void>,
  parseEntry: (entry: StreamEntry) => T,
  serializeToken: (token: T) => string,
  flushOnRead: boolean,
): TokenBuffer<T> {
  // Lazy-init the subscriber client. Redis requires a separate connection for
  // SUBSCRIBE; we duplicate the main client on first cross-process wait.
  let subscriberClient: RedisClientType | null = null
  const subscriberInitLock: { promise: Promise<RedisClientType> | null } = { promise: null }

  async function ensureSubscriber(): Promise<RedisClientType> {
    if (subscriberClient) {
      return subscriberClient
    }
    if (!subscriberInitLock.promise) {
      subscriberInitLock.promise = (async () => {
        const dup = client.duplicate() as RedisClientType
        await dup.connect()
        subscriberClient = dup
        return dup
      })()
    }
    return subscriberInitLock.promise
  }

  function* publishChange(): Operation<void> {
    yield* call(() => client.publish(changeChannel(id), '1'))
  }

  function* notifyChange(): Operation<void> {
    const signal = getSignal(id)
    signal.send()
    yield* publishChange()
  }

  function* claimWriter(
    ownerId: string,
    activationEpoch: number,
  ): Operation<TokenBufferWriter<T>> {
    if (!ownerId || !Number.isSafeInteger(activationEpoch) || activationEpoch < 0) {
      throw new Error('Writer owner and nonnegative activation epoch are required')
    }
    const claimed = yield* call(() =>
      client.eval(
        `local currentEpoch = redis.call('HGET', KEYS[1], 'writerEpoch')
         local currentOwner = redis.call('HGET', KEYS[1], 'writerOwner')
         local requestedEpoch = tonumber(ARGV[2])
         if currentEpoch then
           local epoch = tonumber(currentEpoch)
           if requestedEpoch < epoch then return 0 end
           if requestedEpoch == epoch and currentOwner ~= ARGV[1] then return 0 end
         end
         redis.call('HSET', KEYS[1], 'writerOwner', ARGV[1], 'writerEpoch', ARGV[2])
         return 1`,
        { keys: [metaKey(id)], arguments: [ownerId, String(activationEpoch)] },
      ),
    )
    if (Number(claimed) !== 1) {
      throw new StaleTokenWriterError()
    }
    const fence = { streamId: id, ownerId, activationEpoch }
    return {
      fence,
      *append(tokens): Operation<number> {
        const serialized = tokens.map(serializeToken)
        const result = yield* call(() =>
          client.eval(
            `${luaFencedWriterGuard(2, -1)}
             if redis.call('HGET', KEYS[2], 'completed') == 'true' then return -2 end
             for i = 3, #ARGV do redis.call('XADD', KEYS[1], '*', 'token', ARGV[i]) end
             return redis.call('XLEN', KEYS[1])`,
            {
              keys: [streamKey(id), metaKey(id)],
              arguments: [ownerId, String(activationEpoch), ...serialized],
            },
          ),
        )
        if (Number(result) === -1) throw new StaleTokenWriterError()
        if (Number(result) === -2) throw new Error('Buffer is closed')
        yield* notifyChange()
        return Number(result)
      },
      *complete(): Operation<void> {
        const result = yield* call(() =>
          client.eval(
            `${luaFencedWriterGuard(1, 0)}
             if redis.call('HGET', KEYS[1], 'completed') == 'true' then return 2 end
             redis.call('HSET', KEYS[1], 'completed', 'true')
             return 1`,
            { keys: [metaKey(id)], arguments: [ownerId, String(activationEpoch)] },
          ),
        )
        if (Number(result) === 0) throw new StaleTokenWriterError()
        if (Number(result) === 1) yield* notifyChange()
      },
      *fail(error): Operation<void> {
        const result = yield* call(() =>
          client.eval(
            `${luaFencedWriterGuard(1, 0)}
             if redis.call('HGET', KEYS[1], 'completed') == 'true' then return 2 end
             redis.call('HSET', KEYS[1], 'completed', 'true', 'error', ARGV[3])
             return 1`,
            {
              keys: [metaKey(id)],
              arguments: [ownerId, String(activationEpoch), error.message.slice(0, 1024)],
            },
          ),
        )
        if (Number(result) === 0) throw new StaleTokenWriterError()
        if (Number(result) === 1) yield* notifyChange()
      },
    }
  }

  return {
    id,

    *claimWriter(request) {
      return yield* claimWriter(request.ownerId, request.activationEpoch)
    },

    *append(tokens) {
      const result = yield* call(() =>
        client.eval(
          `if redis.call('HEXISTS', KEYS[2], 'writerOwner') == 1 then return -1 end
           if redis.call('HGET', KEYS[2], 'completed') == 'true' then return -2 end
           for i = 1, #ARGV do redis.call('XADD', KEYS[1], '*', 'token', ARGV[i]) end
           return redis.call('XLEN', KEYS[1])`,
          {
            keys: [streamKey(id), metaKey(id)],
            arguments: tokens.map(serializeToken),
          },
        ),
      )
      if (Number(result) === -1) throw new StaleTokenWriterError('A fenced writer owns this buffer')
      if (Number(result) === -2) throw new Error('Buffer is closed')
      yield* notifyChange()
      return Number(result)
    },

    *complete() {
      const result = yield* call(() =>
        client.eval(
          `if redis.call('HEXISTS', KEYS[1], 'writerOwner') == 1 then return 0 end
           if redis.call('HGET', KEYS[1], 'completed') == 'true' then return 2 end
           redis.call('HSET', KEYS[1], 'completed', 'true')
           return 1`,
          { keys: [metaKey(id)], arguments: [] },
        ),
      )
      if (Number(result) === 0) throw new StaleTokenWriterError('A fenced writer owns this buffer')
      if (Number(result) === 1) yield* notifyChange()
    },

    *fail(error) {
      const result = yield* call(() =>
        client.eval(
          `if redis.call('HEXISTS', KEYS[1], 'writerOwner') == 1 then return 0 end
           if redis.call('HGET', KEYS[1], 'completed') == 'true' then return 2 end
           redis.call('HSET', KEYS[1], 'completed', 'true', 'error', ARGV[1])
           return 1`,
          { keys: [metaKey(id)], arguments: [error.message.slice(0, 1024)] },
        ),
      )
      if (Number(result) === 0) throw new StaleTokenWriterError('A fenced writer owns this buffer')
      if (Number(result) === 1) yield* notifyChange()
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
        yield* call(() => client.hSet(metaKey(id), { flushedUpTo: String(afterLSN + tokens.length) }))
      }

      return { tokens, lsn: allTokens.length }
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
      const signal = getSignal(id)
      const channel = changeChannel(id)

      // Cross-process notification (REQ-063): subscribe to the Redis pub/sub
      // change channel AND the in-process signal, then re-check state.
      // Subscribe-before-recheck closes the dropped-wakeup race: if a remote
      // append happened between the caller's last state check and this
      // subscription, the recheck catches it. If not, we block on a combined
      // signal that fires on either an in-process mutation or a pub/sub
      // message from another process.
      const task = yield* spawn(function* () {
        const inProcessSub = yield* signal

        const subClient = yield* call(() => ensureSubscriber())

        // Create a local signal that fires on either in-process or pub/sub
        // notifications. This lets us race both sources cleanly.
        const combined = createSignal<void, void>()
        const combinedSub = yield* combined

        // Wire pub/sub messages → combined signal
        yield* call(async () => {
          await subClient.subscribe(channel, () => {
            combined.send()
          })
        })

        // Re-check state after subscribing (closes the race window).
        const currentCount = yield* call(() => client.xLen(key))
        if (currentCount > afterLSN) {
          void subClient.unsubscribe(channel)
          return
        }

        const completed = yield* call(() => client.hGet(metaKey(id), 'completed'))
        if (completed === 'true') {
          void subClient.unsubscribe(channel)
          return
        }

        // Also wire in-process signal → combined signal
        // (race the in-process sub against the combined sub)
        const raceTask = yield* spawn(function* () {
          const result = yield* inProcessSub.next()
          if (!result.done) {
            combined.send()
          }
        })

        // Block until either source fires
        const result = yield* combinedSub.next()
        if (!result.done) {
          void subClient.unsubscribe(channel)
          return
        }

        // Cleanup
        void subClient.unsubscribe(channel)
        yield* raceTask
      })
      yield* task
    },
  }
}
