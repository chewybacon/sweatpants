import { createSignal, each } from 'effection'
import type { Operation, Signal } from 'effection'

import type {
  SessionEntry,
  SessionRegistryStore,
  TokenBuffer,
  TokenBufferStore,
} from './types.ts'

export function createInMemoryBuffer<T>(id: string): TokenBuffer<T> {
  const tokens: T[] = []
  let completed = false
  let error: Error | null = null
  const changeSignal: Signal<void, void> = createSignal<void, void>()

  return {
    id,
    *append(newTokens: T[]): Operation<number> {
      if (completed || error) {
        throw new Error('Buffer is closed')
      }
      tokens.push(...newTokens)
      changeSignal.send()
      return tokens.length
    },
    *complete(): Operation<void> {
      completed = true
      changeSignal.send()
    },
    *fail(err: Error): Operation<void> {
      error = err
      changeSignal.send()
    },
    *read(afterLSN = 0): Operation<{ tokens: T[]; lsn: number }> {
      return {
        tokens: tokens.slice(afterLSN),
        lsn: tokens.length,
      }
    },
    *isComplete(): Operation<boolean> {
      return completed
    },
    *getError(): Operation<Error | null> {
      return error
    },
    *waitForChange(afterLSN: number): Operation<void> {
      if (tokens.length > afterLSN || completed || error) {
        return
      }

      for (const _ of yield* each(changeSignal)) {
        break
      }
    },
  }
}

export function createInMemoryBufferStore<T>(): TokenBufferStore<T> {
  const buffers = new Map<string, TokenBuffer<T>>()

  return {
    *create(id: string): Operation<TokenBuffer<T>> {
      if (buffers.has(id)) {
        throw new Error(`Buffer ${id} already exists`)
      }
      const buffer = createInMemoryBuffer<T>(id)
      buffers.set(id, buffer)
      return buffer
    },
    *get(id: string): Operation<TokenBuffer<T> | null> {
      return buffers.get(id) ?? null
    },
    *delete(id: string): Operation<void> {
      buffers.delete(id)
    },
  }
}

export function createInMemoryRegistryStore(): SessionRegistryStore {
  const entries = new Map<string, SessionEntry>()

  return {
    *get(sessionId: string): Operation<SessionEntry | null> {
      return entries.get(sessionId) ?? null
    },
    *set(sessionId: string, entry: SessionEntry): Operation<void> {
      entries.set(sessionId, entry)
    },
    *delete(sessionId: string): Operation<void> {
      entries.delete(sessionId)
    },
    *updateRefCount(sessionId: string, delta: number): Operation<number> {
      const entry = entries.get(sessionId)
      if (!entry) {
        throw new Error(`Session ${sessionId} not found`)
      }
      entry.refCount += delta
      return entry.refCount
    },
  }
}
