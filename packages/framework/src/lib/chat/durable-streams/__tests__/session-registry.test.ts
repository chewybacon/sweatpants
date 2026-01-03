/**
 * Session Registry Tests
 *
 * Tests the SessionRegistry which manages:
 * - Session lifecycle (acquire/release with refCount)
 * - Buffer ownership (registry owns buffer cleanup)
 * - Disconnect/reconnect scenarios (Option D: single-server)
 *
 * Architecture:
 *   Client Request ──acquire──> Registry ──creates──> Session + Buffer + Writer
 *                  ──release──>          ──cleanup──> (when refCount=0 + complete)
 *
 * Key Scenario (Option D):
 *   1. Client connects, acquires session, LLM starts streaming
 *   2. Client disconnects (release), but LLM keeps writing
 *   3. Client reconnects (acquire), resumes reading from LSN
 *   4. Client finishes reading, releases
 *   5. Session is complete + refCount=0 → cleanup
 */
import { describe, it, expect } from './vitest-effection'
import { sleep, resource } from 'effection'
import type { Operation, Subscription, Stream } from 'effection'
import type { TokenFrame } from '../types'
import {
  createInMemoryBufferStore,
  createInMemoryRegistryStore,
  createPullStream,
  createMockLLMStream,
} from './test-utils'
import { createSessionRegistry } from '../session-registry'

// =============================================================================
// TEST HELPER: Create test registry with proper scoping
// =============================================================================

function* useTestRegistry() {
  const bufferStore = createInMemoryBufferStore<string>()
  const registryStore = createInMemoryRegistryStore<string>()
  const registry = yield* createSessionRegistry(bufferStore, registryStore)

  return { registry, bufferStore, registryStore }
}

// =============================================================================
// SCENARIO TESTS
// =============================================================================

describe('Session Registry', () => {
  describe('Basic Lifecycle', () => {
    it('should create new session on first acquire', function* () {
      const { registry, bufferStore } = yield* useTestRegistry()

      const session = yield* registry.acquire('session-1', {
        source: createMockLLMStream('Hello world'),
      })

      expect(session.id).toBe('session-1')
      expect(session.buffer).toBeDefined()
      expect(yield* session.status()).toBe('streaming')

      // Buffer should exist
      const buffer = yield* bufferStore.get('session-1')
      expect(buffer).not.toBe(null)
    })

    it('should return same session on second acquire with incremented refCount', function* () {
      const { registry, registryStore } = yield* useTestRegistry()

      const session1 = yield* registry.acquire('session-2', {
        source: createMockLLMStream('Hello world'),
      })

      // Check initial refCount
      const entry1 = yield* registryStore.get('session-2')
      expect(entry1?.refCount).toBe(1)

      // Second acquire
      const session2 = yield* registry.acquire('session-2')

      // Should be same session
      expect(session2.id).toBe(session1.id)
      expect(session2.buffer).toBe(session1.buffer)

      // RefCount should be 2
      const entry2 = yield* registryStore.get('session-2')
      expect(entry2?.refCount).toBe(2)
    })

    it('should cleanup when last release AND session complete', function* () {
      const { registry, bufferStore, registryStore } = yield* useTestRegistry()

      // Create session with fast stream
      const session = yield* registry.acquire('session-3', {
        source: createMockLLMStream('Quick', { tokenDelayMs: 5 }),
      })

      // Wait for stream to complete
      yield* sleep(50)
      expect(yield* session.status()).toBe('complete')

      // Release
      yield* registry.release('session-3')

      // Should be cleaned up
      yield* sleep(20) // Give cleanup time to run
      const entry = yield* registryStore.get('session-3')
      expect(entry).toBe(null)

      const buffer = yield* bufferStore.get('session-3')
      expect(buffer).toBe(null)
    })

    it('should NOT cleanup if session still streaming after release', function* () {
      const { registry, bufferStore } = yield* useTestRegistry()

      // Create session with slow stream
      const session = yield* registry.acquire('session-4', {
        source: createMockLLMStream('Slow stream with many words', { tokenDelayMs: 50 }),
      })

      expect(yield* session.status()).toBe('streaming')

      // Release while still streaming
      yield* registry.release('session-4')

      // Should NOT be cleaned up yet (deferred)
      yield* sleep(20)

      // Buffer should still exist (LLM still writing)
      const buffer = yield* bufferStore.get('session-4')
      expect(buffer).not.toBe(null)

      // Wait for stream to complete
      yield* sleep(300)

      // Now should be cleaned up
      yield* sleep(50)
      const bufferAfter = yield* bufferStore.get('session-4')
      expect(bufferAfter).toBe(null)
    })
  })

  describe('Client Disconnect/Reconnect (Option D)', () => {
    it('should keep LLM writer alive when client disconnects mid-stream', function* () {
      const { registry } = yield* useTestRegistry()

      // Client connects, starts LLM
      const session = yield* registry.acquire('reconnect-1', {
        source: createMockLLMStream('Hello world from LLM', { tokenDelayMs: 20 }),
      })

      // Read first token
      const reader: Subscription<TokenFrame<string>, void> = yield* createPullStream(
        session.buffer
      )
      const firstToken = yield* reader.next()
      expect((firstToken.value as TokenFrame<string>).token).toBe('Hello')

      // Client "disconnects" (releases without reading all)
      yield* registry.release('reconnect-1')

      // LLM writer should still be running - wait for it to finish
      yield* sleep(150)

      // Buffer should have all tokens
      const { tokens } = yield* session.buffer.read()
      expect(tokens.join('')).toBe('Hello world from LLM')

      // Session should be complete
      expect(yield* session.status()).toBe('complete')
    })

    it('should allow reconnect to resume reading from last LSN', function* () {
      const { registry } = yield* useTestRegistry()

      // Client 1 connects, starts LLM
      const session1 = yield* registry.acquire('reconnect-2', {
        source: createMockLLMStream('One Two Three Four', { tokenDelayMs: 20 }),
      })

      // Read first two tokens
      const reader1: Subscription<TokenFrame<string>, void> = yield* createPullStream(
        session1.buffer
      )
      const t1 = yield* reader1.next()
      expect((t1.value as TokenFrame<string>).token).toBe('One')

      const t2 = yield* reader1.next()
      expect((t2.value as TokenFrame<string>).token).toBe(' Two')
      const disconnectLSN = (t2.value as TokenFrame<string>).lsn

      // Client 1 disconnects
      yield* registry.release('reconnect-2')

      // Wait a bit, LLM continues
      yield* sleep(50)

      // Client 2 reconnects from last LSN
      const session2 = yield* registry.acquire('reconnect-2')

      // Should be same buffer
      expect(session2.buffer).toBe(session1.buffer)

      // Read remaining tokens from where we left off
      const reader2: Subscription<TokenFrame<string>, void> = yield* createPullStream(
        session2.buffer,
        disconnectLSN
      )

      const remaining: string[] = []
      let result = yield* reader2.next()
      while (!result.done) {
        remaining.push((result.value as TokenFrame<string>).token)
        result = yield* reader2.next()
      }

      expect(remaining.join('')).toBe(' Three Four')
    })

    it('should cleanup after reconnected client finishes reading', function* () {
      const { registry, bufferStore, registryStore } = yield* useTestRegistry()

      // Client 1 connects, starts fast LLM
      yield* registry.acquire('reconnect-3', {
        source: createMockLLMStream('Fast', { tokenDelayMs: 5 }),
      })

      // Client 1 disconnects immediately
      yield* registry.release('reconnect-3')

      // Wait for LLM to complete
      yield* sleep(50)

      // Session still exists (deferred cleanup, but complete now)
      // Actually it should cleanup since refCount=0 and complete
      yield* sleep(50)

      // Client 2 reconnects - but session might be gone
      // This is the edge case: what if client reconnects AFTER cleanup?
      const entry = yield* registryStore.get('reconnect-3')

      // If entry is null, the session was cleaned up (expected in this case)
      // If entry exists, we can reconnect
      if (entry) {
        yield* registry.acquire('reconnect-3')
        yield* registry.release('reconnect-3')
      }

      // Final state: should be cleaned up
      yield* sleep(50)
      const bufferAfter = yield* bufferStore.get('reconnect-3')
      expect(bufferAfter).toBe(null)
    })
  })

  describe('Multi-Client', () => {
    it('should track refCount for multiple concurrent clients', function* () {
      const { registry, registryStore } = yield* useTestRegistry()

      // Client 1 connects
      yield* registry.acquire('multi-1', {
        source: createMockLLMStream('Shared stream', { tokenDelayMs: 20 }),
      })

      // Client 2 connects
      yield* registry.acquire('multi-1')

      // Client 3 connects
      yield* registry.acquire('multi-1')

      // RefCount should be 3
      const entry = yield* registryStore.get('multi-1')
      expect(entry?.refCount).toBe(3)
    })

    it('should cleanup only after ALL clients release', function* () {
      const { registry, bufferStore } = yield* useTestRegistry()

      // Create session
      yield* registry.acquire('multi-2', {
        source: createMockLLMStream('Shared', { tokenDelayMs: 5 }),
      })
      yield* registry.acquire('multi-2')
      yield* registry.acquire('multi-2')

      // Wait for completion
      yield* sleep(50)

      // Release one client
      yield* registry.release('multi-2')
      yield* sleep(20)

      // Should still exist (refCount = 2)
      let buffer = yield* bufferStore.get('multi-2')
      expect(buffer).not.toBe(null)

      // Release second client
      yield* registry.release('multi-2')
      yield* sleep(20)

      // Should still exist (refCount = 1)
      buffer = yield* bufferStore.get('multi-2')
      expect(buffer).not.toBe(null)

      // Release last client
      yield* registry.release('multi-2')
      yield* sleep(20)

      // Now should be cleaned up
      buffer = yield* bufferStore.get('multi-2')
      expect(buffer).toBe(null)
    })
  })

  describe('Error Handling', () => {
    it('should throw when acquiring non-existent session without source', function* () {
      const { registry } = yield* useTestRegistry()

      let errorThrown = false
      try {
        yield* registry.acquire('does-not-exist')
      } catch (err) {
        errorThrown = true
        expect((err as Error).message).toContain('no source provided')
      }

      expect(errorThrown).toBe(true)
    })

    it('should set error status when LLM stream fails', function* () {
      const { registry } = yield* useTestRegistry()

      // Create a stream that fails
      const failingStream: Stream<string, void> = resource(function* (provide) {
        let count = 0
        yield* provide({
          *next(): Operation<IteratorResult<string, void>> {
            count++
            if (count <= 2) {
              yield* sleep(5)
              return { done: false, value: `token${count}` }
            }
            throw new Error('LLM Error')
          },
        })
      })

      const session = yield* registry.acquire('error-1', {
        source: failingStream,
      })

      // Wait for error
      yield* sleep(50)

      expect(yield* session.status()).toBe('error')
    })
  })

  describe('Full E2E: Disconnect and Reconnect Flow', () => {
    it('should handle complete flow: connect → read → disconnect → reconnect → finish → cleanup', function* () {
      const { registry, bufferStore } = yield* useTestRegistry()
      const events: string[] = []

      // 1. Client connects, starts LLM
      events.push('client1:connect')
      const session1 = yield* registry.acquire('e2e-session', {
        source: createMockLLMStream('The quick brown fox', { tokenDelayMs: 30 }),
      })

      // 2. Read some tokens
      const reader1: Subscription<TokenFrame<string>, void> = yield* createPullStream(
        session1.buffer
      )
      const t1 = yield* reader1.next()
      events.push(`client1:read:${(t1.value as TokenFrame<string>).token}`)
      const lastLSN = (t1.value as TokenFrame<string>).lsn

      // 3. Client disconnects
      events.push('client1:disconnect')
      yield* registry.release('e2e-session')

      // 4. LLM keeps streaming
      yield* sleep(50)
      events.push('llm:still-streaming')
      expect(yield* session1.status()).toBe('streaming')

      // 5. Client reconnects
      events.push('client2:reconnect')
      const session2 = yield* registry.acquire('e2e-session')
      expect(session2.buffer).toBe(session1.buffer)

      // 6. Read remaining tokens
      const reader2: Subscription<TokenFrame<string>, void> = yield* createPullStream(
        session2.buffer,
        lastLSN
      )

      let result = yield* reader2.next()
      while (!result.done) {
        events.push(`client2:read:${(result.value as TokenFrame<string>).token}`)
        result = yield* reader2.next()
      }
      events.push('client2:done-reading')

      // 7. Release
      events.push('client2:disconnect')
      yield* registry.release('e2e-session')

      // 8. Should cleanup
      yield* sleep(50)
      const bufferAfter = yield* bufferStore.get('e2e-session')
      expect(bufferAfter).toBe(null)
      events.push('cleanup:complete')

      // Verify event flow
      expect(events[0]).toBe('client1:connect')
      expect(events[1]).toBe('client1:read:The')
      expect(events[2]).toBe('client1:disconnect')
      expect(events[3]).toBe('llm:still-streaming')
      expect(events[4]).toBe('client2:reconnect')
      expect(events.includes('client2:read: quick')).toBe(true)
      expect(events.includes('client2:read: brown')).toBe(true)
      expect(events.includes('client2:read: fox')).toBe(true)
      expect(events[events.length - 1]).toBe('cleanup:complete')
    })
  })
})
