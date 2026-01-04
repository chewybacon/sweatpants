/**
 * HTTP Smoke Tests for Durable Chat Handler
 *
 * Tests the durable chat handler over real HTTP connections.
 * These tests verify:
 * - HTTP streaming works correctly
 * - Session ID is returned in headers
 * - NDJSON format is correct
 * - Reconnection from LSN works
 */
import { describe, it, expect, afterEach, beforeAll } from 'vitest'
import {
  setupInMemoryDurableStreams,
  createSharedStorage,
  getSharedStores,
  type SharedStorage,
} from '../../../lib/chat/durable-streams'
import { setupDurableStreams } from '../../../lib/chat/durable-streams/setup'
import { ProviderContext, ToolRegistryContext } from '../../../lib/chat/providers/contexts'
import { ollamaProvider } from '../../../lib/chat/providers'
import { createDurableChatHandler } from '../handler'
import { createMockProvider, consumeDurableResponse } from './test-utils'
import { createHttpTestServer, type TestServerHandle } from './http-test-server'
import type { InitializerHook } from '../types'

// =============================================================================
// TEST SETUP
// =============================================================================

/**
 * Create a test handler with mock provider.
 * Uses per-request in-memory storage (no cross-request persistence).
 */
function createTestHandler(mockResponse: string) {
  const provider = createMockProvider({ responses: mockResponse })

  const initializerHooks: InitializerHook[] = [
    function* setupStreams() {
      yield* setupInMemoryDurableStreams<string>()
    },
    function* setupProvider() {
      yield* ProviderContext.set(provider)
    },
    function* setupTools() {
      yield* ToolRegistryContext.set([])
    },
  ]

  return createDurableChatHandler({ initializerHooks })
}

/**
 * Create a test handler with SHARED storage.
 * Sessions persist across HTTP requests, enabling reconnection testing.
 */
function createTestHandlerWithSharedStorage(
  mockResponse: string,
  sharedStorage: SharedStorage<string>,
  options?: { tokenDelayMs?: number }
) {
  const provider = createMockProvider({
    responses: mockResponse,
    tokenDelayMs: options?.tokenDelayMs ?? 0,
  })

  const initializerHooks: InitializerHook[] = [
    function* setupSharedStreams() {
      const { bufferStore, registryStore } = getSharedStores(sharedStorage)
      yield* setupDurableStreams({ bufferStore, registryStore })
    },
    function* setupProvider() {
      yield* ProviderContext.set(provider)
    },
    function* setupTools() {
      yield* ToolRegistryContext.set([])
    },
  ]

  return createDurableChatHandler({ initializerHooks })
}



// =============================================================================
// TESTS
// =============================================================================

describe('Durable Chat Handler HTTP Smoke Tests', () => {
  let server: TestServerHandle

  afterEach(async () => {
    if (server) {
      await server.close()
    }
  })

  describe('Basic HTTP Streaming', () => {
    it('should stream response over HTTP with correct headers', async () => {
      const handler = createTestHandler('Hello from HTTP!')
      server = await createHttpTestServer(handler)

      const response = await fetch(server.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', content: 'Hi' }],
        }),
      })

      // Check headers
      expect(response.status).toBe(200)
      expect(response.headers.get('Content-Type')).toBe('application/x-ndjson')
      expect(response.headers.get('Cache-Control')).toBe('no-cache')
      expect(response.headers.get('X-Session-Id')).toBeTruthy()

      // Consume and verify response
      const result = await consumeDurableResponse(response)

      expect(result.sessionInfo).not.toBeNull()
      expect(result.text).toBe('Hello from HTTP!')
      expect(result.complete).not.toBeNull()
      expect(result.events.length).toBeGreaterThan(0)

      // Verify LSNs are present and ordered
      const lsns = result.events.map(e => e.lsn)
      for (let i = 1; i < lsns.length; i++) {
        expect(lsns[i]).toBeGreaterThan(lsns[i - 1]!)
      }
    })

    it('should return unique session ID for each request', async () => {
      const handler = createTestHandler('Response 1')
      server = await createHttpTestServer(handler)

      const makeRequest = async () => {
        const response = await fetch(server.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messages: [{ role: 'user', content: 'Hi' }],
          }),
        })
        await consumeDurableResponse(response)
        return response.headers.get('X-Session-Id')
      }

      const sessionId1 = await makeRequest()
      const sessionId2 = await makeRequest()

      expect(sessionId1).toBeTruthy()
      expect(sessionId2).toBeTruthy()
      expect(sessionId1).not.toBe(sessionId2)
    })

    it('should handle concurrent requests', async () => {
      const handler = createTestHandler('Concurrent response')
      server = await createHttpTestServer(handler)

      const makeRequest = async (id: number) => {
        const response = await fetch(server.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messages: [{ role: 'user', content: `Request ${id}` }],
          }),
        })
        const result = await consumeDurableResponse(response)
        return {
          sessionId: response.headers.get('X-Session-Id'),
          text: result.text,
        }
      }

      // Fire off 3 concurrent requests
      const results = await Promise.all([
        makeRequest(1),
        makeRequest(2),
        makeRequest(3),
      ])

      // All should succeed with unique session IDs
      const sessionIds = results.map(r => r.sessionId)
      expect(new Set(sessionIds).size).toBe(3)

      // All should have the expected text
      for (const result of results) {
        expect(result.text).toBe('Concurrent response')
      }
    })
  })

  describe('NDJSON Format', () => {
    it('should emit valid NDJSON with lsn and event fields', async () => {
      const handler = createTestHandler('Test NDJSON')
      server = await createHttpTestServer(handler)

      const response = await fetch(server.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', content: 'Hi' }],
        }),
      })

      // Read raw response as text
      const text = await response.text()
      const lines = text.trim().split('\n')

      expect(lines.length).toBeGreaterThan(0)

      // Each line should be valid JSON with lsn and event
      for (const line of lines) {
        const parsed = JSON.parse(line)
        expect(typeof parsed.lsn).toBe('number')
        expect(parsed.event).toBeDefined()
        expect(typeof parsed.event.type).toBe('string')
      }
    })
  })

  describe('Session Reconnection', () => {
    it('should accept reconnection headers and return session ID', async () => {
      const handler = createTestHandler('Test message')
      server = await createHttpTestServer(handler)

      // First request - get session ID
      const response1 = await fetch(server.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', content: 'Hi' }],
        }),
      })

      const sessionId = response1.headers.get('X-Session-Id')
      expect(sessionId).toBeTruthy()
      await consumeDurableResponse(response1)

      // Second request with reconnection headers
      // Note: This creates a NEW session since registries aren't shared,
      // but it verifies the protocol is handled correctly
      const response2 = await fetch(server.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Session-Id': sessionId!,
          'X-Last-LSN': '5',
        },
        body: JSON.stringify({
          messages: [{ role: 'user', content: 'Hi' }],
        }),
      })

      // Should return 200 and preserve the requested session ID
      expect(response2.status).toBe(200)
      expect(response2.headers.get('X-Session-Id')).toBe(sessionId)
    })

    it('should resume from lastLSN on reconnect with shared storage', async () => {
      // Create shared storage that persists across requests
      const sharedStorage = createSharedStorage<string>()

      // Use a multi-word response with delays between tokens to simulate streaming
      // Each word is a token, with 10ms delay between them
      const longResponse = 'word1 word2 word3 word4 word5 word6 word7 word8 word9 word10'
      const handler = createTestHandlerWithSharedStorage(longResponse, sharedStorage, {
        tokenDelayMs: 10, // 10ms between tokens
      })
      server = await createHttpTestServer(handler)

      // Start first request (streaming)
      const response1 = await fetch(server.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', content: 'Hi' }],
        }),
      })

      const sessionId = response1.headers.get('X-Session-Id')
      expect(sessionId).toBeTruthy()

      // Read just the first few events (partial consumption)
      const reader = response1.body!.getReader()
      const decoder = new TextDecoder()
      const partialEvents: Array<{ lsn: number; event: unknown }> = []

      // Read a few chunks to get some events
      for (let i = 0; i < 3; i++) {
        const { value, done } = await reader.read()
        if (done) break
        const text = decoder.decode(value, { stream: true })
        const lines = text.trim().split('\n').filter(Boolean)
        for (const line of lines) {
          try {
            partialEvents.push(JSON.parse(line))
          } catch {
            // Ignore incomplete JSON
          }
        }
      }

      // Cancel the reader (simulate disconnect)
      await reader.cancel()

      // We should have gotten some events
      expect(partialEvents.length).toBeGreaterThan(0)
      const lastLSN = partialEvents[partialEvents.length - 1]!.lsn

      // Small delay to ensure the stream continues in the background
      await new Promise(r => setTimeout(r, 50))

      // Check that session is still in shared storage (LLM still streaming)
      expect(sharedStorage.sessions.has(sessionId!)).toBe(true)
      expect(sharedStorage.buffers.has(sessionId!)).toBe(true)

      // Second request - reconnect from last known LSN
      const response2 = await fetch(server.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Session-Id': sessionId!,
          'X-Last-LSN': String(lastLSN),
        },
        body: JSON.stringify({
          messages: [{ role: 'user', content: 'Hi' }],
        }),
      })

      expect(response2.status).toBe(200)
      expect(response2.headers.get('X-Session-Id')).toBe(sessionId)

      const result2 = await consumeDurableResponse(response2)

      // Should have gotten remaining events after lastLSN
      expect(result2.events.length).toBeGreaterThan(0)

      // All returned LSNs should be > lastLSN
      for (const event of result2.events) {
        expect(event.lsn).toBeGreaterThan(lastLSN)
      }

      // Should have the complete event
      expect(result2.complete).not.toBeNull()
    })
  })

  describe('Error Handling', () => {
    it('should return error event for invalid request', async () => {
      // Create handler without provider to trigger error
      const initializerHooks: InitializerHook[] = [
        function* setupDurableStreams() {
          yield* setupInMemoryDurableStreams<string>()
        },
        function* setupTools() {
          yield* ToolRegistryContext.set([])
        },
        // No provider setup - should cause error
      ]

      const handler = createDurableChatHandler({ initializerHooks })
      server = await createHttpTestServer(handler)

      const response = await fetch(server.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', content: 'Hi' }],
        }),
      })

      // Should still return 200 (error is in the stream)
      expect(response.status).toBe(200)

      const result = await consumeDurableResponse(response)
      expect(result.error).not.toBeNull()
      expect(result.error?.message).toContain('Provider not configured')
    })
  })

  describe('Memory Management / Cleanup', () => {
    it('should cleanup session and buffer after client fully consumes response', async () => {
      const sharedStorage = createSharedStorage<string>()
      const handler = createTestHandlerWithSharedStorage('Test cleanup', sharedStorage)
      server = await createHttpTestServer(handler)

      // Make request and fully consume it
      const response = await fetch(server.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', content: 'Hi' }],
        }),
      })

      const sessionId = response.headers.get('X-Session-Id')!
      expect(sessionId).toBeTruthy()

      // Verify session exists during streaming
      // (Note: with fast mock, it might already be done)
      
      // Fully consume the response
      const result = await consumeDurableResponse(response)
      expect(result.complete).not.toBeNull()

      // Give cleanup a moment to run
      await new Promise(r => setTimeout(r, 50))

      // Session and buffer should be cleaned up after full consumption
      expect(sharedStorage.sessions.has(sessionId)).toBe(false)
      expect(sharedStorage.buffers.has(sessionId)).toBe(false)
    })

    it('should cleanup after multiple sequential requests', async () => {
      const sharedStorage = createSharedStorage<string>()
      const handler = createTestHandlerWithSharedStorage('Sequential test', sharedStorage)
      server = await createHttpTestServer(handler)

      const sessionIds: string[] = []

      // Make 5 sequential requests
      for (let i = 0; i < 5; i++) {
        const response = await fetch(server.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messages: [{ role: 'user', content: `Request ${i}` }],
          }),
        })

        const sessionId = response.headers.get('X-Session-Id')!
        sessionIds.push(sessionId)

        await consumeDurableResponse(response)
      }

      // Give cleanup time to run
      await new Promise(r => setTimeout(r, 100))

      // All sessions should be cleaned up
      expect(sharedStorage.sessions.size).toBe(0)
      expect(sharedStorage.buffers.size).toBe(0)

      // Verify we had unique session IDs
      expect(new Set(sessionIds).size).toBe(5)
    })

    it('should cleanup after concurrent requests', async () => {
      const sharedStorage = createSharedStorage<string>()
      const handler = createTestHandlerWithSharedStorage('Concurrent test', sharedStorage)
      server = await createHttpTestServer(handler)

      // Make 5 concurrent requests
      const requests = Array.from({ length: 5 }, (_, i) =>
        fetch(server.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messages: [{ role: 'user', content: `Request ${i}` }],
          }),
        })
      )

      const responses = await Promise.all(requests)
      const sessionIds = responses.map(r => r.headers.get('X-Session-Id')!)

      // Consume all responses
      await Promise.all(responses.map(r => consumeDurableResponse(r)))

      // Give cleanup time to run
      await new Promise(r => setTimeout(r, 100))

      // All sessions should be cleaned up
      expect(sharedStorage.sessions.size).toBe(0)
      expect(sharedStorage.buffers.size).toBe(0)

      // Verify we had unique session IDs
      expect(new Set(sessionIds).size).toBe(5)
    })

    it('should NOT cleanup session while still streaming (slow provider)', async () => {
      const sharedStorage = createSharedStorage<string>()

      // Use slow streaming to ensure we can observe mid-stream state
      const handler = createTestHandlerWithSharedStorage(
        'word1 word2 word3 word4 word5 word6 word7 word8 word9 word10',
        sharedStorage,
        { tokenDelayMs: 20 }
      )
      server = await createHttpTestServer(handler)

      const response = await fetch(server.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', content: 'Hi' }],
        }),
      })

      const sessionId = response.headers.get('X-Session-Id')!

      // Read just one chunk (partial consumption)
      const reader = response.body!.getReader()
      await reader.read()

      // Cancel the reader (disconnect)
      await reader.cancel()

      // Session should still exist because LLM is still streaming
      // (with slow provider, it won't be done yet)
      expect(sharedStorage.sessions.has(sessionId)).toBe(true)
      expect(sharedStorage.buffers.has(sessionId)).toBe(true)

      // Wait for streaming to complete
      await new Promise(r => setTimeout(r, 300))

      // Now it should be cleaned up (refCount=0 and complete)
      expect(sharedStorage.sessions.has(sessionId)).toBe(false)
      expect(sharedStorage.buffers.has(sessionId)).toBe(false)
    })

    it('should handle EventEmitter cleanup when buffer is deleted', async () => {
      const sharedStorage = createSharedStorage<string>()
      const handler = createTestHandlerWithSharedStorage('Emitter cleanup', sharedStorage)
      server = await createHttpTestServer(handler)

      // Make a request
      const response = await fetch(server.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', content: 'Hi' }],
        }),
      })

      const sessionId = response.headers.get('X-Session-Id')!
      await consumeDurableResponse(response)

      // Give cleanup time
      await new Promise(r => setTimeout(r, 50))

      // Buffer should be deleted
      expect(sharedStorage.buffers.has(sessionId)).toBe(false)

      // The EventEmitter should have been cleaned up (no listeners)
      // We can't directly test this without accessing internals,
      // but we verify no errors occur and buffer is removed
    })
  })
})

// =============================================================================
// LLM INTEGRATION TESTS (requires Ollama)
// =============================================================================

/**
 * Check if Ollama is available by making a test request.
 */
async function isOllamaAvailable(): Promise<boolean> {
  try {
    const ollamaUrl = process.env['OLLAMA_URL'] ?? 'http://localhost:11434'
    const response = await fetch(`${ollamaUrl}/api/tags`, {
      signal: AbortSignal.timeout(2000),
    })
    return response.ok
  } catch {
    return false
  }
}

/**
 * Create a handler with real Ollama provider.
 */
function createOllamaHandler() {
  const initializerHooks: InitializerHook[] = [
    function* setupStreams() {
      yield* setupInMemoryDurableStreams<string>()
    },
    function* setupProvider() {
      yield* ProviderContext.set(ollamaProvider)
    },
    function* setupTools() {
      yield* ToolRegistryContext.set([])
    },
  ]

  return createDurableChatHandler({ initializerHooks })
}

/**
 * Create a handler with real Ollama provider and shared storage.
 */
function createOllamaHandlerWithSharedStorage(sharedStorage: SharedStorage<string>) {
  const initializerHooks: InitializerHook[] = [
    function* setupSharedStreams() {
      const { bufferStore, registryStore } = getSharedStores(sharedStorage)
      yield* setupDurableStreams({ bufferStore, registryStore })
    },
    function* setupProvider() {
      yield* ProviderContext.set(ollamaProvider)
    },
    function* setupTools() {
      yield* ToolRegistryContext.set([])
    },
  ]

  return createDurableChatHandler({ initializerHooks })
}

describe('Durable Chat Handler - Ollama Integration', () => {
  let server: TestServerHandle
  let ollamaAvailable: boolean

  beforeAll(async () => {
    ollamaAvailable = await isOllamaAvailable()
    if (!ollamaAvailable) {
      console.log('Ollama not available, skipping LLM integration tests')
    }
  })

  afterEach(async () => {
    if (server) {
      await server.close()
    }
  })

  describe('Basic LLM Streaming', () => {
    it('should stream a real LLM response', async () => {
      if (!ollamaAvailable) return

      const handler = createOllamaHandler()
      server = await createHttpTestServer(handler)

      const response = await fetch(server.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', content: 'Say "hello" and nothing else.' }],
        }),
      })

      expect(response.status).toBe(200)
      expect(response.headers.get('Content-Type')).toBe('application/x-ndjson')
      expect(response.headers.get('X-Session-Id')).toBeTruthy()

      const result = await consumeDurableResponse(response)

      // Should have session info, text events, and complete
      expect(result.sessionInfo).not.toBeNull()
      expect(result.complete).not.toBeNull()
      expect(result.text.toLowerCase()).toContain('hello')
      expect(result.events.length).toBeGreaterThan(2)
    }, 30000) // 30s timeout for LLM

    it('should handle a simple math question', async () => {
      if (!ollamaAvailable) return

      const handler = createOllamaHandler()
      server = await createHttpTestServer(handler)

      const response = await fetch(server.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', content: 'What is 2 + 2? Reply with just the number.' }],
        }),
      })

      expect(response.status).toBe(200)

      const result = await consumeDurableResponse(response)

      expect(result.complete).not.toBeNull()
      expect(result.text).toContain('4')
    }, 30000)
  })

  describe('LLM Reconnection', () => {
    it('should reconnect to an active LLM stream', async () => {
      if (!ollamaAvailable) return

      const sharedStorage = createSharedStorage<string>()
      const handler = createOllamaHandlerWithSharedStorage(sharedStorage)
      server = await createHttpTestServer(handler)

      // Ask for a longer response to ensure we can disconnect mid-stream
      // Use a prompt that requires substantial output
      const response1 = await fetch(server.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [{
            role: 'user',
            content: 'Write a short poem about the ocean with at least 8 lines. Take your time and be creative.',
          }],
        }),
      })

      const sessionId = response1.headers.get('X-Session-Id')
      expect(sessionId).toBeTruthy()

      // Read partial response
      const reader = response1.body!.getReader()
      const decoder = new TextDecoder()
      const partialEvents: Array<{ lsn: number; event: unknown }> = []

      // Read just 2-3 chunks to get minimal events, then disconnect quickly
      for (let i = 0; i < 3; i++) {
        const { value, done } = await reader.read()
        if (done) break
        const text = decoder.decode(value, { stream: true })
        const lines = text.trim().split('\n').filter(Boolean)
        for (const line of lines) {
          try {
            partialEvents.push(JSON.parse(line))
          } catch {
            // Ignore incomplete JSON
          }
        }
      }

      // Cancel (simulate disconnect)
      await reader.cancel()

      expect(partialEvents.length).toBeGreaterThan(0)
      const lastLSN = partialEvents[partialEvents.length - 1]!.lsn

      // Check if session still exists (it might have completed if LLM was very fast)
      const sessionStillActive = sharedStorage.sessions.has(sessionId!)

      if (sessionStillActive) {
        // Session still streaming - test reconnection
        const response2 = await fetch(server.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Session-Id': sessionId!,
            'X-Last-LSN': String(lastLSN),
          },
          body: JSON.stringify({
            messages: [{
              role: 'user',
              content: 'Write a short poem about the ocean with at least 8 lines. Take your time and be creative.',
            }],
          }),
        })

        expect(response2.status).toBe(200)
        expect(response2.headers.get('X-Session-Id')).toBe(sessionId)

        const result2 = await consumeDurableResponse(response2)

        // Should have remaining events
        expect(result2.events.length).toBeGreaterThan(0)

        // All LSNs should be after our last seen
        for (const event of result2.events) {
          expect(event.lsn).toBeGreaterThan(lastLSN)
        }

        // Should complete
        expect(result2.complete).not.toBeNull()
      } else {
        // Session already completed - verify cleanup happened correctly
        // This is also valid behavior (fast LLM, cleanup worked)
        expect(sharedStorage.buffers.has(sessionId!)).toBe(false)
        console.log('[LLM Reconnect Test] Session completed before reconnect - cleanup verified')
      }
    }, 60000) // 60s timeout for reconnection test
  })

  describe('Multi-turn Conversation', () => {
    it('should handle a multi-turn conversation', async () => {
      if (!ollamaAvailable) return

      const handler = createOllamaHandler()
      server = await createHttpTestServer(handler)

      // First turn
      const response1 = await fetch(server.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [
            { role: 'user', content: 'My name is Alice.' },
          ],
        }),
      })

      const result1 = await consumeDurableResponse(response1)
      expect(result1.complete).not.toBeNull()

      // Second turn - should remember context
      const response2 = await fetch(server.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [
            { role: 'user', content: 'My name is Alice.' },
            { role: 'assistant', content: result1.text },
            { role: 'user', content: 'What is my name?' },
          ],
        }),
      })

      const result2 = await consumeDurableResponse(response2)
      expect(result2.complete).not.toBeNull()
      expect(result2.text.toLowerCase()).toContain('alice')
    }, 60000)
  })
})
