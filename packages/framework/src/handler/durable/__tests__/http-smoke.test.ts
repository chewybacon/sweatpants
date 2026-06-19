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
} from '../../../lib/chat/durable-streams/index.ts'
import { setupDurableStreams } from '../../../lib/chat/durable-streams/setup.ts'
import type { RetentionPolicy } from '@sweatpants/durable-streams'
import { ProviderContext, ToolRegistryContext } from '../../../lib/chat/providers/contexts.ts'
import { ollamaProvider } from '../../../lib/chat/providers/index.ts'
import { createDurableChatHandler } from '../handler.ts'
import { createMockProvider, consumeDurableResponse } from './test-utils.ts'
import { createHttpTestServer, type TestServerHandle } from './http-test-server.ts'
import type { InitializerHook } from '../types.ts'

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
  options?: { tokenDelayMs?: number; retentionPolicy?: RetentionPolicy }
) {
  const provider = createMockProvider({
    responses: mockResponse,
    tokenDelayMs: options?.tokenDelayMs ?? 0,
  })

  const initializerHooks: InitializerHook[] = [
    function* setupSharedStreams() {
      const { bufferStore, registryStore } = getSharedStores(sharedStorage)
      yield* setupDurableStreams({
        bufferStore,
        registryStore,
        ...(options?.retentionPolicy ? { retentionPolicy: options.retentionPolicy } : {}),
      })
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
      expect(response.headers.get('Cache-Control')).toBe('no-store')
      expect(response.headers.get('X-Session-Id')).toBeTruthy()
      expect(response.headers.get('Stream-Next-Offset')).toBeTruthy()
      expect(response.headers.get('ETag')).toBeTruthy()

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

      // Second request with protocol query reconnection
      // Note: This creates a NEW session since registries aren't shared,
      // but it verifies the protocol is handled correctly
      const reconnectUrl = new URL(server.url)
      reconnectUrl.searchParams.set('sessionId', sessionId!)
      reconnectUrl.searchParams.set('offset', '5')

      const response2 = await fetch(reconnectUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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

      // Second request - reconnect from last known LSN via query
      const reconnectUrl = new URL(server.url)
      reconnectUrl.searchParams.set('sessionId', sessionId!)
      reconnectUrl.searchParams.set('offset', String(lastLSN))

      const response2 = await fetch(reconnectUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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

    it('should support URL-based reconnect with offset query', async () => {
      const sharedStorage = createSharedStorage<string>()
      const handler = createTestHandlerWithSharedStorage(
        'url reconnect stream test payload',
        sharedStorage,
        { tokenDelayMs: 5 }
      )
      server = await createHttpTestServer(handler)

      const response1 = await fetch(server.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', content: 'Hi' }],
        }),
      })

      const sessionId = response1.headers.get('X-Session-Id')!
      expect(sessionId).toBeTruthy()

      const reader = response1.body!.getReader()
      const decoder = new TextDecoder()
      let lastLSN = 0

      for (let i = 0; i < 2; i++) {
        const { value, done } = await reader.read()
        if (done || !value) break
        const text = decoder.decode(value, { stream: true })
        for (const line of text.trim().split('\n').filter(Boolean)) {
          try {
            const parsed = JSON.parse(line) as { lsn: number }
            lastLSN = Math.max(lastLSN, parsed.lsn)
          } catch {
            // Ignore incomplete chunks
          }
        }
      }
      await reader.cancel()

      const reconnectUrl = new URL(server.url)
      reconnectUrl.pathname = `/sessions/${encodeURIComponent(sessionId)}`
      reconnectUrl.searchParams.set('offset', String(lastLSN))

      const response2 = await fetch(reconnectUrl.toString(), {
        method: 'GET',
      })

      expect(response2.status).toBe(200)
      expect(response2.headers.get('X-Session-Id')).toBe(sessionId)
      expect(response2.headers.get('Stream-Next-Offset')).toBeTruthy()

      const result2 = await consumeDurableResponse(response2)
      for (const event of result2.events) {
        expect(event.lsn).toBeGreaterThan(lastLSN)
      }
    })
  })

  describe('Protocol Live Modes', () => {
    it('should return 204 for long-poll timeout when up to date', async () => {
      const sharedStorage = createSharedStorage<string>()
      const handler = createTestHandlerWithSharedStorage(
        'long poll timeout validation',
        sharedStorage,
        { tokenDelayMs: 20 }
      )
      server = await createHttpTestServer(handler)

      const response1 = await fetch(server.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', content: 'Hi' }],
        }),
      })

      const sessionId = response1.headers.get('X-Session-Id')!
      expect(sessionId).toBeTruthy()

      const headUrl = new URL(server.url)
      headUrl.pathname = `/sessions/${encodeURIComponent(sessionId)}`
      const headResponse = await fetch(headUrl.toString(), { method: 'HEAD' })
      const tailOffset = Number.parseInt(
        headResponse.headers.get('Stream-Next-Offset') ?? '0',
        10,
      )

      const pollUrl = new URL(server.url)
      pollUrl.pathname = `/sessions/${encodeURIComponent(sessionId)}`
      pollUrl.searchParams.set('live', 'long-poll')
      pollUrl.searchParams.set('offset', String(tailOffset))
      pollUrl.searchParams.set('timeout', '0')

      const pollResponse = await fetch(pollUrl.toString(), { method: 'GET' })
      expect(pollResponse.status).toBe(204)
      expect(pollResponse.headers.get('Stream-Up-To-Date')).toBe('true')
      expect(pollResponse.headers.get('Stream-Cursor')).toBeTruthy()

      await response1.body?.cancel()
    })

    it('should stream SSE control/data events', async () => {
      const sharedStorage = createSharedStorage<string>()
      const handler = createTestHandlerWithSharedStorage(
        'sse mode validation payload with enough tokens to stay active',
        sharedStorage,
        { tokenDelayMs: 20 },
      )
      server = await createHttpTestServer(handler)

      const response1 = await fetch(server.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', content: 'Hi' }],
        }),
      })

      const sessionId = response1.headers.get('X-Session-Id')!
      expect(sessionId).toBeTruthy()

      const sseUrl = new URL(server.url)
      sseUrl.pathname = `/sessions/${encodeURIComponent(sessionId)}`
      sseUrl.searchParams.set('live', 'sse')
      sseUrl.searchParams.set('offset', '0')

      const sseResponse = await fetch(sseUrl.toString(), { method: 'GET' })
      expect(sseResponse.status).toBe(200)
      expect(sseResponse.headers.get('Content-Type')).toBe('text/event-stream')

      const text = await sseResponse.text()
      expect(text).toContain('event: data')
      expect(text).toContain('event: control')
      expect(text).toContain('streamNextOffset')

      await response1.body?.cancel()
    })

    it('should treat offset=now as current tail for catch-up reads', async () => {
      const sharedStorage = createSharedStorage<string>()
      const handler = createTestHandlerWithSharedStorage(
        'offset now test payload',
        sharedStorage,
        { tokenDelayMs: 20 },
      )
      server = await createHttpTestServer(handler)

      const response1 = await fetch(server.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', content: 'Hi' }],
        }),
      })

      const sessionId = response1.headers.get('X-Session-Id')!
      expect(sessionId).toBeTruthy()

      const nowUrl = new URL(server.url)
      nowUrl.pathname = `/sessions/${encodeURIComponent(sessionId)}`
      nowUrl.searchParams.set('offset', 'now')

      const nowResponse = await fetch(nowUrl.toString(), { method: 'GET' })
      expect(nowResponse.status).toBe(200)
      expect(nowResponse.headers.get('Stream-Up-To-Date')).toBe('true')
      expect(await nowResponse.text()).toBe('')

      await response1.body?.cancel()
    })

    it('should support protocol interoperability lifecycle for external clients', async () => {
      const sharedStorage = createSharedStorage<string>()
      const handler = createTestHandlerWithSharedStorage('interop lifecycle', sharedStorage, {
        retentionPolicy: { mode: 'retain_forever' },
      })
      server = await createHttpTestServer(handler)

      const sessionId = `interop-${crypto.randomUUID()}`
      const sessionUrl = new URL(server.url)
      sessionUrl.pathname = `/sessions/${encodeURIComponent(sessionId)}`

      // Create stream
      const createResponse = await fetch(sessionUrl.toString(), { method: 'PUT' })
      expect(createResponse.status).toBe(201)
      expect(createResponse.headers.get('Stream-Next-Offset')).toBe('0000000000000000')

      // Append payload as external producer
      const appendResponse = await fetch(sessionUrl.toString(), {
        method: 'POST',
        body: JSON.stringify({ type: 'text', content: 'external client payload' }),
      })
      expect(appendResponse.status).toBe(204)
      expect(appendResponse.headers.get('Stream-Next-Offset')).toBe('0000000000000001')

      // Long-poll at tail should timeout with 204 + cursor
      const pollUrl = new URL(sessionUrl)
      pollUrl.searchParams.set('offset', '1')
      pollUrl.searchParams.set('live', 'long-poll')
      pollUrl.searchParams.set('timeout', '0')
      const pollResponse = await fetch(pollUrl.toString(), { method: 'GET' })
      expect(pollResponse.status).toBe(204)
      expect(pollResponse.headers.get('Stream-Up-To-Date')).toBe('true')
      expect(pollResponse.headers.get('Stream-Cursor')).toBeTruthy()

      // Close stream
      const closeResponse = await fetch(sessionUrl.toString(), {
        method: 'POST',
        headers: { 'Stream-Closed': 'true' },
      })
      expect(closeResponse.status).toBe(204)
      expect(closeResponse.headers.get('Stream-Closed')).toBe('true')

      // Catch-up read from start after close should be finite
      const readUrl = new URL(sessionUrl)
      readUrl.searchParams.set('offset', '0')
      const readResponse = await fetch(readUrl.toString(), { method: 'GET' })
      expect(readResponse.status).toBe(200)
      const readBody = await readResponse.text()
      expect(readBody).toContain('external client payload')

      // HEAD metadata reflects closed stream
      const headResponse = await fetch(sessionUrl.toString(), { method: 'HEAD' })
      expect(headResponse.status).toBe(200)
      expect(headResponse.headers.get('Stream-Next-Offset')).toBeTruthy()

      // Delete stream
      const deleteResponse = await fetch(sessionUrl.toString(), { method: 'DELETE' })
      expect(deleteResponse.status).toBe(204)

      // After delete, stream should no longer be found
      const missingHead = await fetch(sessionUrl.toString(), { method: 'HEAD' })
      expect(missingHead.status).toBe(404)
    })

    it('should wake long-poll readers when DELETE races with active read', async () => {
      const sharedStorage = createSharedStorage<string>()
      const handler = createTestHandlerWithSharedStorage('delete race', sharedStorage, {
        retentionPolicy: { mode: 'retain_forever' },
      })
      server = await createHttpTestServer(handler)

      const sessionId = `delete-race-${crypto.randomUUID()}`
      const sessionUrl = new URL(server.url)
      sessionUrl.pathname = `/sessions/${encodeURIComponent(sessionId)}`

      const createResponse = await fetch(sessionUrl.toString(), { method: 'PUT' })
      expect(createResponse.status).toBe(201)

      const pollUrl = new URL(sessionUrl)
      pollUrl.searchParams.set('offset', '0')
      pollUrl.searchParams.set('live', 'long-poll')
      pollUrl.searchParams.set('timeout', '10')

      const pollPromise = fetch(pollUrl.toString(), { method: 'GET' })
      await new Promise(r => setTimeout(r, 30))

      const deleteResponse = await fetch(sessionUrl.toString(), { method: 'DELETE' })
      expect(deleteResponse.status).toBe(204)

      const pollResponse = await pollPromise
      expect(pollResponse.status).toBe(204)
      expect(pollResponse.headers.get('Stream-Closed')).toBe('true')

      const appendAfterDelete = await fetch(sessionUrl.toString(), {
        method: 'POST',
        body: 'late write',
      })
      expect(appendAfterDelete.status).toBe(404)
    })

    it('should keep in-flight chat response stable when DELETE races with writer', async () => {
      const sharedStorage = createSharedStorage<string>()
      const handler = createTestHandlerWithSharedStorage(
        'token1 token2 token3 token4 token5 token6',
        sharedStorage,
        { tokenDelayMs: 25, retentionPolicy: { mode: 'retain_forever' } }
      )
      server = await createHttpTestServer(handler)

      const response = await fetch(server.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', content: 'race writer delete' }],
        }),
      })

      const sessionId = response.headers.get('X-Session-Id')
      expect(sessionId).toBeTruthy()

      const reader = response.body!.getReader()
      await reader.read()

      const deleteUrl = new URL(server.url)
      deleteUrl.pathname = `/sessions/${encodeURIComponent(sessionId!)}`

      const deleteResponse = await fetch(deleteUrl.toString(), { method: 'DELETE' })
      expect(deleteResponse.status).toBe(204)

      await reader.cancel()

      const headAfterDelete = await fetch(deleteUrl.toString(), { method: 'HEAD' })
      expect(headAfterDelete.status).toBe(404)
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

  describe('Durability / Retention', () => {
    it('should delete session and buffer after client fully consumes response by default', async () => {
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

      // Give runtime cleanup a moment to run
      await new Promise(r => setTimeout(r, 50))

      // Default retention policy auto-deletes successful sessions.
      expect(sharedStorage.sessions.has(sessionId)).toBe(false)
      expect(sharedStorage.buffers.has(sessionId)).toBe(false)
    })

    it('should delete data after multiple sequential requests by default', async () => {
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

      // Give runtime cleanup time to run
      await new Promise(r => setTimeout(r, 100))

      // All sessions should be deleted after successful close.
      expect(sharedStorage.sessions.size).toBe(0)
      expect(sharedStorage.buffers.size).toBe(0)

      // Verify we had unique session IDs
      expect(new Set(sessionIds).size).toBe(5)
    })

    it('should delete data after concurrent requests by default', async () => {
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

      // Give runtime cleanup time to run
      await new Promise(r => setTimeout(r, 100))

      // All sessions should be deleted after successful close.
      expect(sharedStorage.sessions.size).toBe(0)
      expect(sharedStorage.buffers.size).toBe(0)

      // Verify we had unique session IDs
      expect(new Set(sessionIds).size).toBe(5)
    })

    it('should retain session while streaming but delete after completion (slow provider)', async () => {
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

      // It should be deleted after successful completion.
      expect(sharedStorage.sessions.has(sessionId)).toBe(false)
      expect(sharedStorage.buffers.has(sessionId)).toBe(false)
    })

    it('should keep buffer available for replay when retain_forever is configured', async () => {
      const sharedStorage = createSharedStorage<string>()
      const handler = createTestHandlerWithSharedStorage('Replay retention', sharedStorage, {
        retentionPolicy: { mode: 'retain_forever' },
      })
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

      // Give runtime cleanup time
      await new Promise(r => setTimeout(r, 50))

      // Buffer should still exist for replay.
      expect(sharedStorage.buffers.has(sessionId)).toBe(true)
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
    const model = process.env['OLLAMA_MODEL'] ?? 'lfm2.5:latest'
    const response = await fetch(`${ollamaUrl}/api/tags`, {
      signal: AbortSignal.timeout(2000),
    })
    if (!response.ok) {
      return false
    }
    const body = await response.json() as { models?: Array<{ name?: string; model?: string }> }
    return (body.models ?? []).some((entry) => entry.name === model || entry.model === model)
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

describe.skipIf(process.env['RUN_LIVE_PROVIDER_TESTS'] !== 'yes')('Durable Chat Handler - Ollama Integration', () => {
  let server: TestServerHandle
  let ollamaAvailable: boolean

  beforeAll(async () => {
    const liveEnabled = process.env['RUN_LIVE_PROVIDER_TESTS'] === 'yes'
    ollamaAvailable = liveEnabled && await isOllamaAvailable()
    if (!ollamaAvailable) {
      console.log('Live Ollama tests gated or unavailable, skipping LLM integration tests')
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
        // Session still streaming - test reconnection via query
        const reconnectUrl = new URL(server.url)
        reconnectUrl.searchParams.set('sessionId', sessionId!)
        reconnectUrl.searchParams.set('offset', String(lastLSN))

        const response2 = await fetch(reconnectUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
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
        // Session already completed - verify durable retention still keeps the buffer.
        expect(sharedStorage.buffers.has(sessionId!)).toBe(true)
        console.log('[LLM Reconnect Test] Session completed before reconnect - retention verified')
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
