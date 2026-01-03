/**
 * Hello Chat Scenario Tests
 *
 * Full end-to-end scenarios that simulate the complete HTTP request flow:
 *
 *   Client Request → SessionRegistry.acquire() → LLM Writer spawned
 *                                              ↓
 *                    TokenBuffer ← tokens ← LLM Stream
 *                                              ↓
 *                    Web ReadableStream → HTTP Response → Client
 *                                              ↓
 *                    Client done → release() → cleanup (when complete)
 *
 * These tests use the SessionRegistry to manage session lifecycle,
 * validating that:
 * - Sessions are created on first request
 * - LLM writers run independently of client connections
 * - Cleanup happens when session completes and all clients release
 * - Reconnection works within the same server
 */
import { describe, it, expect } from './vitest-effection'
import { sleep, call, resource, useScope } from 'effection'
import type { Operation, Stream, Subscription, Scope } from 'effection'
import type { TokenFrame } from '../types'
import {
  createMockLLMStream,
  createWebStreamFromBuffer,
  consumeResponse,
  createPullStream,
  setupInMemoryDurableStreams,
} from './test-utils'

// =============================================================================
// TEST HELPERS
// =============================================================================

function* useTestRegistry() {
  // Use the DI setup helper - sets contexts and returns the setup
  const { registry, bufferStore, registryStore } = yield* setupInMemoryDurableStreams<string>()
  return { registry, bufferStore, registryStore }
}

// =============================================================================
// SCENARIO TESTS
// =============================================================================

describe('Hello Chat Scenarios (with SessionRegistry)', () => {
  describe('Happy Path: Single Request', () => {
    it('should handle a complete request: acquire → stream → release → cleanup', function* () {
      const { registry, bufferStore } = yield* useTestRegistry()
      const scope: Scope = yield* useScope()
      const sessionId = 'happy-path-1'

      // Acquire session (starts LLM writer)
      const session = yield* registry.acquire(sessionId, {
        source: createMockLLMStream('Hello, world!', { tokenDelayMs: 5 }),
      })

      // Create web stream from buffer
      const webStream = createWebStreamFromBuffer(scope, session.buffer)
      const response = new Response(webStream, {
        headers: { 'content-type': 'application/x-ndjson' },
      })

      // Consume response as client
      const result = yield* call(() => consumeResponse(response))

      // Verify response content
      expect(result.fullMessage).toBe('Hello, world!')
      expect(result.tokens).toEqual(['Hello,', ' world!'])
      expect(result.frames).toHaveLength(2)
      expect(result.frames[0]?.lsn).toBe(1)
      expect(result.frames[1]?.lsn).toBe(2)

      // Release session
      yield* registry.release(sessionId)

      // Wait for cleanup
      yield* sleep(50)

      // Verify cleanup happened
      const buffer = yield* bufferStore.get(sessionId)
      expect(buffer).toBe(null)
    })

    it('should stream a longer message through the full pipeline', function* () {
      const { registry, bufferStore } = yield* useTestRegistry()
      const scope: Scope = yield* useScope()
      const sessionId = 'happy-path-2'
      const message = 'The quick brown fox jumps over the lazy dog'

      // Acquire and start LLM
      const session = yield* registry.acquire(sessionId, {
        source: createMockLLMStream(message, { tokenDelayMs: 2 }),
      })

      // Create web stream and response
      const webStream = createWebStreamFromBuffer(scope, session.buffer)
      const response = new Response(webStream)

      // Consume
      const result = yield* call(() => consumeResponse(response))

      expect(result.fullMessage).toBe(message)
      expect(result.tokens).toHaveLength(9) // 9 words
      expect(result.frames.map((f) => f.lsn)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])

      // Cleanup
      yield* registry.release(sessionId)
      yield* sleep(50)
      expect(yield* bufferStore.get(sessionId)).toBe(null)
    })
  })

  describe('Multi-Client: Same Session', () => {
    it('should allow two clients to read the same session via web streams', function* () {
      const { registry } = yield* useTestRegistry()
      const scope: Scope = yield* useScope()
      const sessionId = 'multi-client-1'
      const message = 'Shared message for all clients'

      // First client acquires
      const session = yield* registry.acquire(sessionId, {
        source: createMockLLMStream(message, { tokenDelayMs: 5 }),
      })

      // Second client acquires same session
      yield* registry.acquire(sessionId)

      // Create two web streams from same buffer
      const webStream1 = createWebStreamFromBuffer(scope, session.buffer)
      const webStream2 = createWebStreamFromBuffer(scope, session.buffer)

      const response1 = new Response(webStream1)
      const response2 = new Response(webStream2)

      // Both consume in parallel
      const [result1, result2] = yield* call(() =>
        Promise.all([consumeResponse(response1), consumeResponse(response2)])
      )

      // Both should get the full message
      expect(result1.fullMessage).toBe(message)
      expect(result2.fullMessage).toBe(message)
      expect(result1.tokens).toEqual(result2.tokens)

      // Release both
      yield* registry.release(sessionId)
      yield* registry.release(sessionId)
    })
  })

  describe('Reconnect: Client Disconnect and Resume', () => {
    it('should allow client to disconnect and reconnect mid-stream', function* () {
      const { registry, bufferStore } = yield* useTestRegistry()
      const sessionId = 'reconnect-1'

      // Client 1 connects, starts slow stream
      const session1 = yield* registry.acquire(sessionId, {
        source: createMockLLMStream('One Two Three Four Five', { tokenDelayMs: 30 }),
      })

      // Read first two tokens via pull stream
      const reader1: Subscription<TokenFrame<string>, void> = yield* createPullStream(session1.buffer)
      const t1 = yield* reader1.next()
      expect((t1.value as TokenFrame<string>).token).toBe('One')

      const t2 = yield* reader1.next()
      expect((t2.value as TokenFrame<string>).token).toBe(' Two')
      const lastLSN = (t2.value as TokenFrame<string>).lsn

      // Client 1 disconnects (releases)
      yield* registry.release(sessionId)

      // Buffer should still exist (LLM still streaming)
      yield* sleep(20)
      expect(yield* bufferStore.get(sessionId)).not.toBe(null)

      // Client 2 reconnects
      const session2 = yield* registry.acquire(sessionId)
      expect(session2.buffer).toBe(session1.buffer)

      // Read remaining from last LSN
      const reader2: Subscription<TokenFrame<string>, void> = yield* createPullStream(
        session2.buffer,
        lastLSN
      )

      const remaining: string[] = []
      let result = yield* reader2.next()
      while (!result.done) {
        remaining.push((result.value as TokenFrame<string>).token)
        result = yield* reader2.next()
      }

      expect(remaining.join('')).toBe(' Three Four Five')

      // Release and verify cleanup
      yield* registry.release(sessionId)
      yield* sleep(50)
      expect(yield* bufferStore.get(sessionId)).toBe(null)
    })

    it('should allow reconnect via web stream with LSN offset', function* () {
      const { registry, bufferStore } = yield* useTestRegistry()
      const scope: Scope = yield* useScope()
      const sessionId = 'reconnect-web-1'

      // Client 1 starts session
      const session = yield* registry.acquire(sessionId, {
        source: createMockLLMStream('Alpha Beta Gamma Delta', { tokenDelayMs: 20 }),
      })

      // Client 1 reads via web stream
      const webStream1 = createWebStreamFromBuffer(scope, session.buffer, 0)
      const response1 = new Response(webStream1)
      const reader = response1.body!.getReader()
      const decoder = new TextDecoder()

      // Read first frame only
      const { value } = yield* call(() => reader.read())
      const firstFrame: TokenFrame<string> = JSON.parse(decoder.decode(value).trim())
      expect(firstFrame.token).toBe('Alpha')
      const disconnectLSN = firstFrame.lsn

      // Cancel reader (simulates client disconnect)
      yield* call(() => reader.cancel())
      yield* registry.release(sessionId)

      // Wait a bit
      yield* sleep(30)

      // Client 2 reconnects from LSN
      yield* registry.acquire(sessionId)
      const webStream2 = createWebStreamFromBuffer(scope, session.buffer, disconnectLSN)
      const response2 = new Response(webStream2)
      const result2 = yield* call(() => consumeResponse(response2))

      // Should get remaining tokens
      expect(result2.fullMessage).toBe(' Beta Gamma Delta')

      // Cleanup
      yield* registry.release(sessionId)
      yield* sleep(50)
      expect(yield* bufferStore.get(sessionId)).toBe(null)
    })
  })

  describe('Error Handling', () => {
    it('should propagate LLM errors and cleanup', function* () {
      const { registry, bufferStore } = yield* useTestRegistry()
      const sessionId = 'error-1'

      // Create failing stream
      const failingStream: Stream<string, void> = resource(function* (provide) {
        let count = 0
        yield* provide({
          *next(): Operation<IteratorResult<string, void>> {
            count++
            if (count <= 2) {
              yield* sleep(5)
              return { done: false, value: `token${count}` }
            }
            throw new Error('LLM API Error')
          },
        })
      })

      const session = yield* registry.acquire(sessionId, {
        source: failingStream,
      })

      // Wait for error
      yield* sleep(50)
      expect(yield* session.status()).toBe('error')

      // Release and verify cleanup
      yield* registry.release(sessionId)
      yield* sleep(20)
      expect(yield* bufferStore.get(sessionId)).toBe(null)
    })
  })

  describe('Session Lifecycle', () => {
    it('should track session status through lifecycle', function* () {
      const { registry } = yield* useTestRegistry()
      const sessionId = 'lifecycle-1'

      const session = yield* registry.acquire(sessionId, {
        source: createMockLLMStream('Hello', { tokenDelayMs: 20 }),
      })

      // Initially streaming
      expect(yield* session.status()).toBe('streaming')

      // Wait for completion
      yield* sleep(100)
      expect(yield* session.status()).toBe('complete')

      yield* registry.release(sessionId)
    })

    it('should cleanup only after ALL clients release', function* () {
      const { registry, bufferStore } = yield* useTestRegistry()
      const sessionId = 'multi-release-1'

      // Three clients acquire
      yield* registry.acquire(sessionId, {
        source: createMockLLMStream('Shared', { tokenDelayMs: 5 }),
      })
      yield* registry.acquire(sessionId)
      yield* registry.acquire(sessionId)

      // Wait for completion
      yield* sleep(50)

      // Release one by one
      yield* registry.release(sessionId)
      yield* sleep(20)
      expect(yield* bufferStore.get(sessionId)).not.toBe(null)

      yield* registry.release(sessionId)
      yield* sleep(20)
      expect(yield* bufferStore.get(sessionId)).not.toBe(null)

      yield* registry.release(sessionId)
      yield* sleep(20)
      expect(yield* bufferStore.get(sessionId)).toBe(null)
    })
  })

  describe('Full E2E: HTTP-like Request Flow', () => {
    it('should handle complete HTTP-like request lifecycle', function* () {
      const { registry, bufferStore, registryStore } = yield* useTestRegistry()
      const scope: Scope = yield* useScope()
      const events: string[] = []

      // Simulate: POST /chat (starts new session)
      events.push('request:start')
      const sessionId = 'e2e-' + Date.now()

      const session = yield* registry.acquire(sessionId, {
        source: createMockLLMStream('Hello from the LLM assistant!', { tokenDelayMs: 10 }),
      })
      events.push('session:acquired')

      // Check refCount
      const entry = yield* registryStore.get(sessionId)
      expect(entry?.refCount).toBe(1)

      // Create web stream response
      const webStream = createWebStreamFromBuffer(scope, session.buffer)
      const response = new Response(webStream, {
        headers: {
          'content-type': 'application/x-ndjson',
          'x-session-id': sessionId,
        },
      })
      events.push('response:created')

      // Client consumes response
      const result = yield* call(() => consumeResponse(response))
      events.push('response:consumed')

      // Verify full message
      expect(result.fullMessage).toBe('Hello from the LLM assistant!')

      // Simulate: Response finished, release session
      yield* registry.release(sessionId)
      events.push('session:released')

      // Wait for cleanup
      yield* sleep(50)

      // Verify cleanup
      const bufferAfter = yield* bufferStore.get(sessionId)
      expect(bufferAfter).toBe(null)
      events.push('cleanup:verified')

      // Verify event order
      expect(events).toEqual([
        'request:start',
        'session:acquired',
        'response:created',
        'response:consumed',
        'session:released',
        'cleanup:verified',
      ])
    })
  })
})
