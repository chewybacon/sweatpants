import { createSignal, spawn } from 'effection'
import type { Operation, Signal } from 'effection'

import type {
  SessionEntry,
  SessionRegistryStore,
  TokenBuffer,
  TokenBufferStore,
  TokenBufferWriter,
} from './types.ts'
import { StaleTokenWriterError } from './types.ts'

export function createInMemoryBuffer<T>(id: string): TokenBuffer<T> {
  const tokens: T[] = []
  let completed = false
  let error: Error | null = null
  let writerFence: { ownerId: string; activationEpoch: number } | undefined
  const changeSignal: Signal<void, void> = createSignal<void, void>()

  function assertFence(ownerId: string, activationEpoch: number): void {
    if (
      !writerFence ||
      writerFence.ownerId !== ownerId ||
      writerFence.activationEpoch !== activationEpoch
    ) {
      throw new StaleTokenWriterError()
    }
  }

  function append(newTokens: T[]): number {
    if (completed || error) {
      throw new Error('Buffer is closed')
    }
    tokens.push(...newTokens)
    changeSignal.send()
    return tokens.length
  }

  function complete(): void {
    if (completed) return
    completed = true
    changeSignal.send()
  }

  function fail(err: Error): void {
    if (completed) return
    completed = true
    error = err.message.length <= 1024 ? err : new Error(err.message.slice(0, 1024))
    error.name = err.name
    changeSignal.send()
  }

  return {
    id,
    *claimWriter(request): Operation<TokenBufferWriter<T>> {
      if (!request.ownerId || !Number.isSafeInteger(request.activationEpoch) || request.activationEpoch < 0) {
        throw new Error('Writer owner and nonnegative activation epoch are required')
      }
      if (
        writerFence &&
        (request.activationEpoch < writerFence.activationEpoch ||
          (request.activationEpoch === writerFence.activationEpoch &&
            request.ownerId !== writerFence.ownerId))
      ) {
        throw new StaleTokenWriterError()
      }
      writerFence = { ...request }
      const fence = { streamId: id, ...request }
      return {
        fence,
        *append(newTokens): Operation<number> {
          assertFence(request.ownerId, request.activationEpoch)
          return append(newTokens)
        },
        *complete(): Operation<void> {
          assertFence(request.ownerId, request.activationEpoch)
          complete()
        },
        *fail(err): Operation<void> {
          assertFence(request.ownerId, request.activationEpoch)
          fail(err)
        },
      }
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

      // Subscribe-then-recheck inside a child task, and wait for that task to
      // complete. Race-free (the recheck closes the dropped-signal window) and
      // leak-free (the task tears down its own subscription on return; if this
      // operation is halted externally, structured concurrency halts the child
      // task too). Review B-2: avoid `resolve()`+`task.halt()` re-entrancy —
      // resolving synchronously resumes a waiter that halts the task we're
      // inside of, which corrupts the subscription cleanup.
      const task = yield* spawn(function* () {
        const sub = yield* changeSignal
        if (tokens.length > afterLSN || completed || error) {
          return
        }
        const result = yield* sub.next()
        if (result.done) {
          return
        }
      })
      yield* task
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
