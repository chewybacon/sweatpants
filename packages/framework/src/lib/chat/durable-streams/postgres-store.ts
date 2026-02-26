import { call, sleep, type Operation } from 'effection'

import type {
  SessionEntry,
  SessionRegistryStore,
  TokenBuffer,
  TokenBufferStore,
} from './types.ts'

interface PostgresDurableState<T> {
  tokens: T[]
  completed: boolean
  errorMessage: string | null
}

/**
 * Adapter abstraction for Postgres-backed durable stores.
 *
 * Implementations can use LISTEN/NOTIFY in `waitForChange` for efficient wakeups.
 */
export interface PostgresStoreAdapter {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  del(key: string): Promise<void>
  waitForChange?(channel: string, afterLSN: number): Promise<void>
  notifyChange?(channel: string): Promise<void>
}

export interface PostgresStoreConfig<T> {
  adapter: PostgresStoreAdapter
  serialize: (token: T) => string
  deserialize: (token: string) => T
  keyPrefix?: string
  pollIntervalMs?: number
}

function bufferKey(prefix: string, id: string): string {
  return `${prefix}:buffer:${id}`
}

function registryKey(prefix: string, id: string): string {
  return `${prefix}:registry:${id}`
}

function channelKey(prefix: string, id: string): string {
  return `${prefix}:channel:${id}`
}

function toJson<T>(value: T): string {
  return JSON.stringify(value)
}

function fromJson<T>(value: string): T {
  return JSON.parse(value) as T
}

function* readBufferState<T>(
  adapter: PostgresStoreAdapter,
  key: string,
  deserialize: (token: string) => T,
): Operation<PostgresDurableState<T> | null> {
  const raw = yield* call(() => adapter.get(key))
  if (!raw) {
    return null
  }
  const parsed = fromJson<PostgresDurableState<string>>(raw)
  return {
    tokens: parsed.tokens.map(deserialize),
    completed: parsed.completed,
    errorMessage: parsed.errorMessage,
  }
}

function* writeBufferState<T>(
  adapter: PostgresStoreAdapter,
  key: string,
  state: PostgresDurableState<T>,
  serialize: (token: T) => string,
): Operation<void> {
  const persisted: PostgresDurableState<string> = {
    tokens: state.tokens.map(serialize),
    completed: state.completed,
    errorMessage: state.errorMessage,
  }
  yield* call(() => adapter.set(key, toJson(persisted)))
}

export function createPostgresBufferStore<T>(
  config: PostgresStoreConfig<T>,
): TokenBufferStore<T> {
  const {
    adapter,
    serialize,
    deserialize,
    keyPrefix = 'durable-streams',
    pollIntervalMs = 100,
  } = config

  const createBuffer = (id: string): TokenBuffer<T> => {
    const key = bufferKey(keyPrefix, id)
    const channel = channelKey(keyPrefix, id)

    return {
      id,

      *append(tokens: T[]): Operation<number> {
        const state = yield* readBufferState(adapter, key, deserialize)
        if (!state) {
          throw new Error(`Buffer ${id} not found`)
        }
        if (state.completed || state.errorMessage) {
          throw new Error('Buffer is closed')
        }
        state.tokens.push(...tokens)
        yield* writeBufferState(adapter, key, state, serialize)
        if (adapter.notifyChange) {
          yield* call(() => adapter.notifyChange!(channel))
        }
        return state.tokens.length
      },

      *complete(): Operation<void> {
        const state = yield* readBufferState(adapter, key, deserialize)
        if (!state) {
          return
        }
        state.completed = true
        yield* writeBufferState(adapter, key, state, serialize)
        if (adapter.notifyChange) {
          yield* call(() => adapter.notifyChange!(channel))
        }
      },

      *fail(error: Error): Operation<void> {
        const state = yield* readBufferState(adapter, key, deserialize)
        if (!state) {
          return
        }
        state.errorMessage = error.message
        yield* writeBufferState(adapter, key, state, serialize)
        if (adapter.notifyChange) {
          yield* call(() => adapter.notifyChange!(channel))
        }
      },

      *read(afterLSN = 0): Operation<{ tokens: T[]; lsn: number }> {
        const state = yield* readBufferState(adapter, key, deserialize)
        if (!state) {
          return { tokens: [], lsn: 0 }
        }
        return {
          tokens: state.tokens.slice(afterLSN),
          lsn: state.tokens.length,
        }
      },

      *isComplete(): Operation<boolean> {
        const state = yield* readBufferState(adapter, key, deserialize)
        return state?.completed ?? false
      },

      *getError(): Operation<Error | null> {
        const state = yield* readBufferState(adapter, key, deserialize)
        if (!state?.errorMessage) {
          return null
        }
        return new Error(state.errorMessage)
      },

      *waitForChange(afterLSN: number): Operation<void> {
        while (true) {
          const state = yield* readBufferState(adapter, key, deserialize)
          if (!state || state.tokens.length > afterLSN || state.completed || state.errorMessage) {
            return
          }

          if (adapter.waitForChange) {
            yield* call(() => adapter.waitForChange!(channel, afterLSN))
            continue
          }

          yield* sleep(pollIntervalMs)
        }
      },
    }
  }

  return {
    *create(id: string): Operation<TokenBuffer<T>> {
      const key = bufferKey(keyPrefix, id)
      const existing = yield* call(() => adapter.get(key))
      if (existing !== null) {
        throw new Error(`Buffer ${id} already exists`)
      }

      const initial: PostgresDurableState<T> = {
        tokens: [],
        completed: false,
        errorMessage: null,
      }
      yield* writeBufferState(adapter, key, initial, serialize)
      return createBuffer(id)
    },

    *get(id: string): Operation<TokenBuffer<T> | null> {
      const key = bufferKey(keyPrefix, id)
      const raw = yield* call(() => adapter.get(key))
      if (raw === null) {
        return null
      }
      return createBuffer(id)
    },

    *delete(id: string): Operation<void> {
      const key = bufferKey(keyPrefix, id)
      yield* call(() => adapter.del(key))
    },
  }
}

export function createPostgresRegistryStore(
  adapter: PostgresStoreAdapter,
  keyPrefix = 'durable-streams',
): SessionRegistryStore {
  return {
    *get(sessionId: string): Operation<SessionEntry | null> {
      const raw = yield* call(() => adapter.get(registryKey(keyPrefix, sessionId)))
      if (!raw) {
        return null
      }
      return fromJson<SessionEntry>(raw)
    },

    *set(sessionId: string, entry: SessionEntry): Operation<void> {
      yield* call(() =>
        adapter.set(registryKey(keyPrefix, sessionId), toJson(entry)),
      )
    },

    *delete(sessionId: string): Operation<void> {
      yield* call(() => adapter.del(registryKey(keyPrefix, sessionId)))
    },

    *updateRefCount(sessionId: string, delta: number): Operation<number> {
      const current = yield* call(() => adapter.get(registryKey(keyPrefix, sessionId)))
      if (!current) {
        throw new Error(`Session ${sessionId} not found`)
      }
      const parsed = fromJson<SessionEntry>(current)
      parsed.refCount += delta
      yield* call(() =>
        adapter.set(registryKey(keyPrefix, sessionId), toJson(parsed)),
      )
      return parsed.refCount
    },
  }
}
