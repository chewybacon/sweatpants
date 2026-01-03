/**
 * Durable Streams Tests
 *
 * These tests validate the design of the durable streams system by
 * testing the in-memory implementations and core scenarios:
 *
 * 1. Basic write/read flow
 * 2. Multiple clients reading at different rates
 * 3. Client reconnection (resume from LSN)
 * 4. Abort handling
 * 5. Timeout handling
 * 6. Session rehydration (orphaned state)
 */
import { describe, it, expect } from './vitest-effection'
import { resource, spawn, sleep, createSignal, each, ensure, createScope, call } from 'effection'
import type { Operation, Stream, Subscription, Signal } from 'effection'
import type {
  TokenBuffer,
  Session,
  SessionStore,
  SessionManager,
  SessionStatus,
  CreateSessionOptions,
  TokenFrame,
} from '../types'
import {
  createInMemoryBuffer,
  createInMemoryBufferStore,
  createPullStream,
} from './test-utils'

// =============================================================================
// IN-MEMORY SESSION STORE (test-only, not in library)
// =============================================================================

/**
 * In-memory SessionStore for testing the old SessionManager pattern.
 * Note: The SessionRegistry pattern is preferred for production use.
 */
function createInMemorySessionStore<T>(): SessionStore<T> {
  const sessions = new Map<string, Session<T>>()

  return {
    *set(session: Session<T>): Operation<void> {
      sessions.set(session.id, session)
    },

    *get(sessionId: string): Operation<Session<T> | null> {
      return sessions.get(sessionId) ?? null
    },

    *delete(sessionId: string): Operation<void> {
      sessions.delete(sessionId)
    },
  }
}

// =============================================================================
// ACTIVE SESSION (test helper for Session with writer task)
// =============================================================================

/**
 * Create a Session that actively writes from a source stream.
 */
function* createActiveSession<T>(
  id: string,
  buffer: TokenBuffer<T>,
  source: Stream<T, void>,
  options: { timeoutMs?: number } = {}
): Operation<Session<T>> {
  let status: SessionStatus = 'streaming'
  let sessionError: Error | null = null
  const abortSignal: Signal<void, void> = createSignal<void, void>()
  let aborted = false
  let timedOut = false

  // Spawn the writer task
  yield* spawn(function* () {
    // Spawn abort listener
    yield* spawn(function* () {
      for (const _ of yield* each(abortSignal)) {
        aborted = true
        break
      }
    })

    // Spawn timeout watcher if configured
    if (options.timeoutMs !== undefined) {
      yield* spawn(function* () {
        yield* sleep(options.timeoutMs!)
        if (status === 'streaming') {
          timedOut = true
          const err = new Error('Session timeout')
          sessionError = err
          yield* buffer.fail(err)
          status = 'timeout'
        }
      })
    }

    try {
      // Consume source and write to buffer
      const subscription: Subscription<T, void> = yield* source
      let result = yield* subscription.next()

      while (!result.done && !aborted && !timedOut) {
        yield* buffer.append([result.value])
        result = yield* subscription.next()
      }

      if (aborted) {
        yield* buffer.complete()
        status = 'aborted'
      } else if (!timedOut) {
        yield* buffer.complete()
        status = 'complete'
      }
    } catch (err) {
      sessionError = err as Error
      yield* buffer.fail(sessionError)
      status = 'error'
    }
  })

  return {
    id,
    buffer,
    *status(): Operation<SessionStatus> {
      return status
    },
    *getError(): Operation<Error | null> {
      return sessionError
    },
    *abort(): Operation<void> {
      abortSignal.send()
    },
  }
}

/**
 * Create a Session handle for an existing buffer (rehydration).
 */
function* createRehydratedSession<T>(
  id: string,
  buffer: TokenBuffer<T>
): Operation<Session<T>> {
  const isComplete = yield* buffer.isComplete()
  const error = yield* buffer.getError()

  let status: SessionStatus
  if (error) {
    status = 'error'
  } else if (isComplete) {
    status = 'complete'
  } else {
    status = 'orphaned'
  }

  return {
    id,
    buffer,
    *status(): Operation<SessionStatus> {
      return status
    },
    *getError(): Operation<Error | null> {
      return yield* buffer.getError()
    },
    *abort(): Operation<void> {
      // Can't abort an orphaned/completed session
      // Just mark buffer complete if not already
      const complete = yield* buffer.isComplete()
      if (!complete) {
        yield* buffer.complete()
      }
    },
  }
}

// =============================================================================
// SESSION MANAGER (test helper using old pattern)
// =============================================================================

/**
 * In-memory SessionManager for testing.
 * Note: The SessionRegistry pattern is preferred for production use.
 */
function createSessionManager<T>(
  bufferStore: ReturnType<typeof createInMemoryBufferStore<T>>,
  sessionStore: SessionStore<T> = createInMemorySessionStore<T>()
): SessionManager<T> {
  return {
    *getOrCreate(
      sessionId: string,
      options?: CreateSessionOptions<T>
    ): Operation<Session<T>> {
      // 1. Check in-memory session store
      const cached = yield* sessionStore.get(sessionId)
      if (cached) {
        return cached
      }

      // 2. Check durable buffer store
      const existingBuffer = yield* bufferStore.get(sessionId)

      if (existingBuffer) {
        // Rehydrate from existing buffer
        const session = yield* createRehydratedSession(sessionId, existingBuffer)
        yield* sessionStore.set(session)
        return session
      }

      // 3. Create new session
      if (!options?.source) {
        throw new Error('Session not found and no source provided')
      }

      const buffer = yield* bufferStore.create(sessionId)
      const sessionOptions: { timeoutMs?: number } = {}
      if (options.timeoutMs !== undefined) {
        sessionOptions.timeoutMs = options.timeoutMs
      }
      const session = yield* createActiveSession(sessionId, buffer, options.source, sessionOptions)
      yield* sessionStore.set(session)
      return session
    },

    *delete(sessionId: string): Operation<void> {
      yield* sessionStore.delete(sessionId)
      yield* bufferStore.delete(sessionId)
    },
  }
}

// =============================================================================
// RESOURCE WRAPPERS (with automatic cleanup via ensure)
// =============================================================================

/**
 * Use a durable session as a resource.
 * When the scope ends, the session and buffer are deleted from stores.
 */
function useDurableSession<T>(
  sessionManager: SessionManager<T>,
  sessionId: string,
  options?: CreateSessionOptions<T>
): Operation<Session<T>> {
  return resource(function* (provide) {
    // Create or get the session
    const session = yield* sessionManager.getOrCreate(sessionId, options)

    // Register cleanup - runs when scope ends
    yield* ensure(function* () {
      yield* sessionManager.delete(sessionId)
    })

    // Provide the session - resource stays alive until scope ends
    yield* provide(session)
  })
}

/**
 * Use a pull stream as a resource.
 * The stream is automatically cleaned up when scope ends.
 * Returns TokenFrame<T> with token and LSN for reconnect support.
 */
function usePullStream<T>(
  buffer: TokenBuffer<T>,
  startLSN = 0
): Operation<Subscription<TokenFrame<T>, void>> {
  return resource(function* (provide) {
    const subscription: Subscription<TokenFrame<T>, void> = yield* createPullStream(buffer, startLSN)
    yield* provide(subscription)
  })
}

// =============================================================================
// HELPER: Create mock token stream
// =============================================================================

function createMockTokenStream(tokens: string[], delayMs = 0): Stream<string, void> {
  return resource(function* (provide) {
    let index = 0

    yield* provide({
      *next(): Operation<IteratorResult<string, void>> {
        if (delayMs > 0) {
          yield* sleep(delayMs)
        }

        if (index < tokens.length) {
          return { done: false, value: tokens[index++]! }
        }
        return { done: true, value: undefined }
      },
    })
  })
}

// =============================================================================
// TESTS
// =============================================================================

describe('Durable Streams', () => {
  describe('TokenBuffer', () => {
    it('should append and read tokens', function* () {
      const buffer = createInMemoryBuffer<string>('test-1')

      yield* buffer.append(['hello', 'world'])
      const { tokens, lsn } = yield* buffer.read()

      expect(tokens).toEqual(['hello', 'world'])
      expect(lsn).toBe(2)
    })

    it('should read tokens after a specific LSN', function* () {
      const buffer = createInMemoryBuffer<string>('test-2')

      yield* buffer.append(['a', 'b', 'c', 'd'])
      const { tokens, lsn } = yield* buffer.read(2)

      expect(tokens).toEqual(['c', 'd'])
      expect(lsn).toBe(4)
    })

    it('should track completion status', function* () {
      const buffer = createInMemoryBuffer<string>('test-3')

      expect(yield* buffer.isComplete()).toBe(false)

      yield* buffer.complete()

      expect(yield* buffer.isComplete()).toBe(true)
    })

    it('should track error status', function* () {
      const buffer = createInMemoryBuffer<string>('test-4')

      expect(yield* buffer.getError()).toBe(null)

      const error = new Error('test error')
      yield* buffer.fail(error)

      expect(yield* buffer.getError()).toBe(error)
    })

    it('should not allow appending after completion', function* () {
      const buffer = createInMemoryBuffer<string>('test-5')

      yield* buffer.complete()

      let threw = false
      try {
        yield* buffer.append(['too late'])
      } catch {
        threw = true
      }

      expect(threw).toBe(true)
    })
  })

  describe('TokenBufferStore', () => {
    it('should create and retrieve buffers', function* () {
      const store = createInMemoryBufferStore<string>()

      const buffer = yield* store.create('session-1')
      yield* buffer.append(['test'])

      const retrieved = yield* store.get('session-1')
      expect(retrieved).not.toBe(null)

      const { tokens } = yield* retrieved!.read()
      expect(tokens).toEqual(['test'])
    })

    it('should return null for non-existent buffers', function* () {
      const store = createInMemoryBufferStore<string>()

      const buffer = yield* store.get('does-not-exist')
      expect(buffer).toBe(null)
    })

    it('should delete buffers', function* () {
      const store = createInMemoryBufferStore<string>()

      yield* store.create('to-delete')
      yield* store.delete('to-delete')

      const buffer = yield* store.get('to-delete')
      expect(buffer).toBe(null)
    })
  })

  describe('PullStream', () => {
    it('should read tokens as they become available', function* () {
      const buffer = createInMemoryBuffer<string>('pull-1')
      const pullStream: Subscription<TokenFrame<string>, void> = yield* createPullStream(buffer)

      // Append some tokens
      yield* buffer.append(['one', 'two'])

      // Read them
      const result1 = yield* pullStream.next()
      expect(result1.done).toBe(false)
      expect((result1.value as TokenFrame<string>).token).toBe('one')

      const result2 = yield* pullStream.next()
      expect(result2.done).toBe(false)
      expect((result2.value as TokenFrame<string>).token).toBe('two')

      // Complete the buffer
      yield* buffer.complete()

      // Should get done
      const result3 = yield* pullStream.next()
      expect(result3.done).toBe(true)
    })

    it('should start from a specific LSN', function* () {
      const buffer = createInMemoryBuffer<string>('pull-2')

      yield* buffer.append(['a', 'b', 'c', 'd'])
      yield* buffer.complete()

      // Start from LSN 2 (skip 'a', 'b')
      const pullStream: Subscription<TokenFrame<string>, void> = yield* createPullStream(buffer, 2)

      const result1 = yield* pullStream.next()
      expect((result1.value as TokenFrame<string>).token).toBe('c')

      const result2 = yield* pullStream.next()
      expect((result2.value as TokenFrame<string>).token).toBe('d')

      const result3 = yield* pullStream.next()
      expect(result3.done).toBe(true)
    })

    it('should return correct LSN with each token', function* () {
      const buffer = createInMemoryBuffer<string>('pull-lsn')

      yield* buffer.append(['a', 'b', 'c'])
      yield* buffer.complete()

      const pullStream: Subscription<TokenFrame<string>, void> = yield* createPullStream(buffer)

      const result1 = yield* pullStream.next()
      expect((result1.value as TokenFrame<string>).token).toBe('a')
      expect((result1.value as TokenFrame<string>).lsn).toBe(1)

      const result2 = yield* pullStream.next()
      expect((result2.value as TokenFrame<string>).token).toBe('b')
      expect((result2.value as TokenFrame<string>).lsn).toBe(2)

      const result3 = yield* pullStream.next()
      expect((result3.value as TokenFrame<string>).token).toBe('c')
      expect((result3.value as TokenFrame<string>).lsn).toBe(3)

      const result4 = yield* pullStream.next()
      expect(result4.done).toBe(true)
    })

    it('should return correct LSN when starting from offset', function* () {
      const buffer = createInMemoryBuffer<string>('pull-lsn-offset')

      yield* buffer.append(['a', 'b', 'c', 'd', 'e'])
      yield* buffer.complete()

      // Start from LSN 3 (skip 'a', 'b', 'c')
      const pullStream: Subscription<TokenFrame<string>, void> = yield* createPullStream(buffer, 3)

      const result1 = yield* pullStream.next()
      expect((result1.value as TokenFrame<string>).token).toBe('d')
      expect((result1.value as TokenFrame<string>).lsn).toBe(4)

      const result2 = yield* pullStream.next()
      expect((result2.value as TokenFrame<string>).token).toBe('e')
      expect((result2.value as TokenFrame<string>).lsn).toBe(5)
    })
  })

  describe('Session', () => {
    it('should stream from source to buffer', function* () {
      const bufferStore = createInMemoryBufferStore<string>()
      const sessionManager = createSessionManager(bufferStore)

      const source = createMockTokenStream(['hello', 'world'])

      const session = yield* sessionManager.getOrCreate('session-1', { source })

      // Wait for stream to complete
      yield* sleep(50)

      expect(yield* session.status()).toBe('complete')

      const { tokens } = yield* session.buffer.read()
      expect(tokens).toEqual(['hello', 'world'])
    })

    it('should return cached session on second call', function* () {
      const bufferStore = createInMemoryBufferStore<string>()
      const sessionManager = createSessionManager(bufferStore)

      const source = createMockTokenStream(['test'])

      const session1 = yield* sessionManager.getOrCreate('session-2', { source })
      const session2 = yield* sessionManager.getOrCreate('session-2')

      expect(session1).toBe(session2)
    })

    it('should rehydrate session from existing buffer', function* () {
      const bufferStore = createInMemoryBufferStore<string>()

      // Manually create a buffer (simulating previous session)
      const buffer = yield* bufferStore.create('orphan-session')
      yield* buffer.append(['previous', 'data'])
      // Note: NOT completing it - simulating orphaned state

      // Create session manager and get the session
      const sessionManager = createSessionManager(bufferStore)
      const session = yield* sessionManager.getOrCreate('orphan-session')

      expect(yield* session.status()).toBe('orphaned')

      const { tokens } = yield* session.buffer.read()
      expect(tokens).toEqual(['previous', 'data'])
    })

    it('should rehydrate completed session', function* () {
      const bufferStore = createInMemoryBufferStore<string>()

      // Create a completed buffer
      const buffer = yield* bufferStore.create('complete-session')
      yield* buffer.append(['done', 'data'])
      yield* buffer.complete()

      const sessionManager = createSessionManager(bufferStore)
      const session = yield* sessionManager.getOrCreate('complete-session')

      expect(yield* session.status()).toBe('complete')
    })

    it('should throw when no source provided for new session', function* () {
      const bufferStore = createInMemoryBufferStore<string>()
      const sessionManager = createSessionManager(bufferStore)

      let threw = false
      try {
        yield* sessionManager.getOrCreate('new-session')
      } catch (err) {
        threw = true
        expect((err as Error).message).toContain('no source provided')
      }

      expect(threw).toBe(true)
    })
  })

  describe('Abort', () => {
    it('should abort an active session', function* () {
      const bufferStore = createInMemoryBufferStore<string>()
      const sessionManager = createSessionManager(bufferStore)

      // Slow stream that we can abort
      const source = createMockTokenStream(['a', 'b', 'c', 'd', 'e'], 100)

      const session = yield* sessionManager.getOrCreate('abort-session', {
        source,
      })

      // Let it start
      yield* sleep(50)

      // Abort
      yield* session.abort()

      // Give it time to process abort
      yield* sleep(50)

      expect(yield* session.status()).toBe('aborted')
    })
  })

  describe('Multi-client', () => {
    it('should allow multiple clients to read from same buffer', function* () {
      const buffer = createInMemoryBuffer<string>('multi-client')

      // Create two pull streams
      const client1: Subscription<TokenFrame<string>, void> = yield* createPullStream(buffer)
      const client2: Subscription<TokenFrame<string>, void> = yield* createPullStream(buffer)

      // Add tokens
      yield* buffer.append(['shared', 'data'])
      yield* buffer.complete()

      // Both clients should get same data
      const c1r1 = yield* client1.next()
      const c2r1 = yield* client2.next()

      expect((c1r1.value as TokenFrame<string>).token).toBe('shared')
      expect((c2r1.value as TokenFrame<string>).token).toBe('shared')

      const c1r2 = yield* client1.next()
      const c2r2 = yield* client2.next()

      expect((c1r2.value as TokenFrame<string>).token).toBe('data')
      expect((c2r2.value as TokenFrame<string>).token).toBe('data')
    })

    it('should allow clients to read at different positions', function* () {
      const buffer = createInMemoryBuffer<string>('multi-position')

      yield* buffer.append(['a', 'b', 'c', 'd'])
      yield* buffer.complete()

      // Client 1 starts from beginning
      const client1: Subscription<TokenFrame<string>, void> = yield* createPullStream(buffer, 0)

      // Client 2 starts from middle (simulating reconnect)
      const client2: Subscription<TokenFrame<string>, void> = yield* createPullStream(buffer, 2)

      const c1r1 = yield* client1.next()
      const c2r1 = yield* client2.next()

      expect((c1r1.value as TokenFrame<string>).token).toBe('a')
      expect((c2r1.value as TokenFrame<string>).token).toBe('c')
    })
  })

  describe('Reconnect scenario', () => {
    it('should allow client to reconnect and resume from LSN', function* () {
      const bufferStore = createInMemoryBufferStore<string>()
      const sessionManager = createSessionManager(bufferStore)

      // Create initial session
      const source = createMockTokenStream(['token1', 'token2', 'token3'])
      const session = yield* sessionManager.getOrCreate('reconnect-session', {
        source,
      })

      // Wait for completion
      yield* sleep(50)

      // Simulate client 1 reading first 2 tokens then disconnecting
      const client1: Subscription<TokenFrame<string>, void> = yield* createPullStream(session.buffer)
      yield* client1.next() // token1
      yield* client1.next() // token2
      // Client 1 disconnects at LSN 2

      // Simulate new client connecting with LSN 2
      // (In real scenario, this might be a different server)
      const session2 = yield* sessionManager.getOrCreate('reconnect-session')
      const client2: Subscription<TokenFrame<string>, void> = yield* createPullStream(session2.buffer, 2)

      const result = yield* client2.next()
      expect((result.value as TokenFrame<string>).token).toBe('token3')
    })
  })

  // ===========================================================================
  // INTEGRATION TESTS: Resource Cleanup with Scoping
  // ===========================================================================

  describe('Integration: Resource Cleanup', () => {
    it('should delete buffer and session when scope ends after completion', function* () {
      const bufferStore = createInMemoryBufferStore<string>()
      const sessionManager = createSessionManager(bufferStore)

      // Run in a child scope
      const [scope, destroy] = createScope()

      yield* call(() =>
        scope.run(function* () {
          // Use the resource pattern - cleanup is automatic
          const session = yield* useDurableSession(
            sessionManager,
            'cleanup-session',
            { source: createMockTokenStream(['Hello', 'world']) }
          )

          // Verify exists during request
          expect(yield* bufferStore.get('cleanup-session')).not.toBe(null)

          // Consume all tokens
          const pullStream = yield* usePullStream(session.buffer)
          const received: string[] = []

          let result = yield* pullStream.next()
          while (!result.done) {
            received.push((result.value as TokenFrame<string>).token)
            result = yield* pullStream.next()
          }

          expect(received).toEqual(['Hello', 'world'])
          expect(yield* session.status()).toBe('complete')
        })
      )

      // Destroy scope - triggers ensure() cleanup
      yield* call(() => destroy())

      // Verify cleanup happened - run in main scope to check stores
      const bufferAfter = yield* bufferStore.get('cleanup-session')
      expect(bufferAfter).toBe(null)
    })

    it('should delete buffer and session when scope ends mid-stream (abort)', function* () {
      const bufferStore = createInMemoryBufferStore<string>()
      const sessionManager = createSessionManager(bufferStore)

      const [scope, destroy] = createScope()

      yield* call(() =>
        scope.run(function* () {
          // Slow stream - will be in progress when we destroy scope
          const session = yield* useDurableSession(
            sessionManager,
            'abort-cleanup-session',
            { source: createMockTokenStream(['a', 'b', 'c', 'd', 'e'], 100) }
          )

          // Verify it's streaming
          expect(yield* session.status()).toBe('streaming')
          expect(yield* bufferStore.get('abort-cleanup-session')).not.toBe(null)

          // Read just one token
          const pullStream = yield* usePullStream(session.buffer)
          const result = yield* pullStream.next()
          expect((result.value as TokenFrame<string>).token).toBe('a')

          // Scope will be destroyed while stream is still active
        })
      )

      // Destroy scope mid-stream
      yield* call(() => destroy())

      // Verify cleanup happened
      const bufferAfter = yield* bufferStore.get('abort-cleanup-session')
      expect(bufferAfter).toBe(null)
    })

    it('should clean up on error', function* () {
      const bufferStore = createInMemoryBufferStore<string>()
      const sessionManager = createSessionManager(bufferStore)

      const [scope, destroy] = createScope()

      let errorCaught = false

      try {
        yield* call(() =>
          scope.run(function* () {
            const session = yield* useDurableSession(
              sessionManager,
              'error-cleanup-session',
              { source: createMockTokenStream(['data']) }
            )

            // Verify session exists
            expect(yield* bufferStore.get('error-cleanup-session')).not.toBe(null)

            // Wait for completion
            yield* sleep(50)
            expect(yield* session.status()).toBe('complete')

            // Throw an error
            throw new Error('Simulated error')
          })
        )
      } catch (err) {
        errorCaught = true
        expect((err as Error).message).toBe('Simulated error')
      }

      // Destroy scope (may already be destroyed due to error, but call anyway)
      yield* call(() => destroy())

      expect(errorCaught).toBe(true)

      // Verify cleanup happened despite error
      const bufferAfter = yield* bufferStore.get('error-cleanup-session')
      expect(bufferAfter).toBe(null)
    })

    it('should allow nested scopes with independent cleanup', function* () {
      const bufferStore = createInMemoryBufferStore<string>()
      const sessionManager = createSessionManager(bufferStore)

      // Outer scope for session
      const [outerScope, destroyOuter] = createScope()

      yield* call(() =>
        outerScope.run(function* () {
          const session = yield* useDurableSession(
            sessionManager,
            'nested-session',
            { source: createMockTokenStream(['token1', 'token2', 'token3']) }
          )

          // Wait for completion
          yield* sleep(50)

          // Inner scope for first reader
          const [innerScope1, destroyInner1] = createScope()
          yield* call(() =>
            innerScope1.run(function* () {
              const reader = yield* usePullStream(session.buffer, 0)
              const result = yield* reader.next()
              expect((result.value as TokenFrame<string>).token).toBe('token1')
            })
          )
          yield* call(() => destroyInner1())

          // Session should still exist after inner scope destroyed
          expect(yield* bufferStore.get('nested-session')).not.toBe(null)

          // Another inner scope for second reader at different position
          const [innerScope2, destroyInner2] = createScope()
          yield* call(() =>
            innerScope2.run(function* () {
              const reader = yield* usePullStream(session.buffer, 1)
              const result = yield* reader.next()
              expect((result.value as TokenFrame<string>).token).toBe('token2')
            })
          )
          yield* call(() => destroyInner2())

          // Session should still exist
          expect(yield* bufferStore.get('nested-session')).not.toBe(null)
        })
      )

      // Destroy outer scope - now session should be cleaned up
      yield* call(() => destroyOuter())

      const bufferAfter = yield* bufferStore.get('nested-session')
      expect(bufferAfter).toBe(null)
    })

    it('should handle happy path end-to-end with automatic cleanup', function* () {
      const bufferStore = createInMemoryBufferStore<string>()
      const sessionManager = createSessionManager(bufferStore)

      // Track lifecycle events
      const events: string[] = []

      const [scope, destroy] = createScope()

      yield* call(() =>
        scope.run(function* () {
          events.push('scope:start')

          // Create session
          const session = yield* useDurableSession(
            sessionManager,
            'e2e-session',
            { source: createMockTokenStream(['Hello', ' ', 'world', '!'], 10) }
          )
          events.push('session:created')

          // Create pull stream
          const pullStream = yield* usePullStream(session.buffer)
          events.push('pullstream:created')

          // Consume all tokens
          const tokens: string[] = []
          let result = yield* pullStream.next()
          while (!result.done) {
            tokens.push((result.value as TokenFrame<string>).token)
            result = yield* pullStream.next()
          }
          events.push('tokens:consumed')

          expect(tokens.join('')).toBe('Hello world!')
          expect(yield* session.status()).toBe('complete')
          events.push('scope:complete')
        })
      )

      events.push('scope:ending')
      yield* call(() => destroy())
      events.push('scope:destroyed')

      // Verify cleanup
      expect(yield* bufferStore.get('e2e-session')).toBe(null)
      events.push('cleanup:verified')

      // Verify lifecycle order
      expect(events).toEqual([
        'scope:start',
        'session:created',
        'pullstream:created',
        'tokens:consumed',
        'scope:complete',
        'scope:ending',
        'scope:destroyed',
        'cleanup:verified',
      ])
    })
  })
})
