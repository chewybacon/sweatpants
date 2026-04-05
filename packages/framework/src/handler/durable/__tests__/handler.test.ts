/**
 * Durable Chat Handler Tests
 *
 * Black-box tests for the durable chat handler.
 * Tests the complete request lifecycle:
 *
 *   Client Request → Handler → SessionRegistry → LLM Writer → Buffer → Response
 *
 * These tests verify:
 * - New session creation and streaming
 * - Session info emission
 * - Text streaming with LSN
 * - Tool calling and execution
 * - Reconnection from LSN
 * - Error handling
 */
import { describe, it, expect } from './vitest-effection.ts'
import { call } from 'effection'
import {
  createInMemoryBufferStore,
  createInMemoryRegistryStore,
  setupDurableStreams,
} from '../../../lib/chat/durable-streams/index.ts'
import type { RetentionPolicy } from '@sweatpants/durable-streams'
import { ProviderContext, ToolRegistryContext } from '../../../lib/chat/providers/contexts.ts'
import { createDurableChatHandler } from '../handler.ts'
import type { InitializerHook, IsomorphicTool } from '../types.ts'
import {
  createMockProvider,
  createMockTool,
  consumeDurableResponse,
  createChatRequest,
} from './test-utils.ts'

// =============================================================================
// TEST HELPERS
// =============================================================================

/**
 * Create initializer hooks for testing.
 */
function createTestHooks(
  provider: ReturnType<typeof createMockProvider>,
  tools: IsomorphicTool[] = [],
  options: { retentionPolicy?: RetentionPolicy } = {}
): InitializerHook[] {
  const bufferStore = createInMemoryBufferStore<string>()
  const registryStore = createInMemoryRegistryStore()

  return [
    // Set up durable streams infrastructure
    function* setupDurable() {
      yield* setupDurableStreams({
        bufferStore,
        registryStore,
        ...(options.retentionPolicy ? { retentionPolicy: options.retentionPolicy } : {}),
      })
    },
    // Set up provider
    function* setupProvider() {
      yield* ProviderContext.set(provider)
    },
    // Set up tools
    function* setupTools() {
      yield* ToolRegistryContext.set(tools)
    },
  ]
}

/**
 * Helper to make a chat request and consume the response.
 */
async function makeRequest(
  handler: (req: Request) => Promise<Response>,
  messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>,
  options: {
    sessionId?: string
    conversationId?: string
    lastLSN?: number
    enabledTools?: boolean | string[]
  } = {}
) {
  const { request } = createChatRequest(messages, options)
  const response = await handler(request)
  const result = await consumeDurableResponse(response)
  const sessionId = response.headers.get('X-Session-Id')
  return { response, result, sessionId }
}

// =============================================================================
// TESTS
// =============================================================================

describe('Durable Chat Handler', () => {
  describe('New Session: Basic Streaming', () => {
    it('should reuse the same durable session for repeated conversationId requests', function* () {
      const provider = createMockProvider({ responses: ['First response', 'Second response'] })
      const handler = createDurableChatHandler({
        initializerHooks: createTestHooks(provider, [], {
          retentionPolicy: { mode: 'retain_forever' },
        }),
      })

      const conversationId = 'thread-123'

      const first = yield* call(() =>
        makeRequest(handler, [{ role: 'user', content: 'Hello' }], {
          conversationId,
        })
      )

      expect(first.sessionId).toBeDefined()

      const { request: replayRequest } = createChatRequest([], {
        method: 'GET',
        conversationId,
      })
      const replayResponse = yield* call(() => handler(replayRequest))
      expect(replayResponse.status).toBe(200)
      expect(replayResponse.headers.get('X-Session-Id')).toBe(first.sessionId)

      const replayBody = yield* call(() => replayResponse.text())
      expect(replayBody).toContain('First response')

      const { request: headRequest } = createChatRequest([], {
        method: 'HEAD',
        conversationId,
      })
      const headResponse = yield* call(() => handler(headRequest))
      expect(headResponse.status).toBe(200)
      expect(headResponse.headers.get('X-Session-Id')).toBe(first.sessionId)
    })

    it('should stream a simple text response with session info', function* () {
      const provider = createMockProvider({ responses: 'Hello, world!' })
      const handler = createDurableChatHandler({
        initializerHooks: createTestHooks(provider),
      })

      const { result, sessionId } = yield* call(() =>
        makeRequest(handler, [{ role: 'user', content: 'Hi' }])
      )

      // Should have session ID
      expect(sessionId).toBeDefined()

      // Should have session info event
      expect(result.sessionInfo).not.toBeNull()
      expect(result.sessionInfo?.type).toBe('session_info')
      expect(result.sessionInfo?.capabilities.streaming).toBe(true)

      // Should have text
      expect(result.text).toBe('Hello, world!')

      // Should have complete event
      expect(result.complete).not.toBeNull()
      expect(result.complete?.type).toBe('complete')

      // All events should have LSN
      expect(result.events.length).toBeGreaterThan(0)
      for (const event of result.events) {
        expect(typeof event.lsn).toBe('number')
        expect(event.lsn).toBeGreaterThan(0)
      }
    })

    it('should include LSN in correct order', function* () {
      const provider = createMockProvider({ responses: 'One Two Three' })
      const handler = createDurableChatHandler({
        initializerHooks: createTestHooks(provider),
      })

      const { result } = yield* call(() =>
        makeRequest(handler, [{ role: 'user', content: 'Count' }])
      )

      // LSNs should be monotonically increasing
      const lsns = result.events.map((e) => e.lsn)
      for (let i = 1; i < lsns.length; i++) {
        expect(lsns[i]).toBeGreaterThan(lsns[i - 1]!)
      }
    })
  })

  describe('Tool Calling', () => {
    it('should execute server-side tools and emit results', function* () {
      const echoTool = createMockTool('echo', 'Echoes input')
      const provider = createMockProvider({
        responses: 'Let me echo that',
        toolCalls: [{ id: 'call-1', name: 'echo', arguments: { input: 'hello' } }],
      })
      const handler = createDurableChatHandler({
        initializerHooks: createTestHooks(provider, [echoTool]),
        maxToolIterations: 1,
      })

      const { result } = yield* call(() =>
        makeRequest(handler, [{ role: 'user', content: 'Echo something' }], {
          enabledTools: true,
        })
      )

      // Should have tool calls event
      expect(result.toolCalls).not.toBeNull()
      expect(result.toolCalls?.[0]?.name).toBe('echo')

      // Should have tool result
      expect(result.toolResults).not.toBeNull()
      expect(result.toolResults?.[0]?.name).toBe('echo')
      expect(result.toolResults?.[0]?.content).toContain('Mock result for: hello')
    })
  })

  describe('Error Handling', () => {
    it('should emit error event when provider throws', function* () {
      const provider = createMockProvider({
        customStream: () => {
          throw new Error('Provider error')
        },
      })
      const handler = createDurableChatHandler({
        initializerHooks: createTestHooks(provider),
      })

      const { result } = yield* call(() =>
        makeRequest(handler, [{ role: 'user', content: 'Hi' }])
      )

      // Should have error event
      expect(result.error).not.toBeNull()
      expect(result.error?.message).toContain('Provider error')
    })

    it('should emit error when provider is not configured', function* () {
      const handler = createDurableChatHandler({
        initializerHooks: [
          // Only setup durable streams, no provider
          function* () {
            const bufferStore = createInMemoryBufferStore<string>()
            const registryStore = createInMemoryRegistryStore()
            yield* setupDurableStreams({ bufferStore, registryStore })
          },
          function* () {
            yield* ToolRegistryContext.set([])
          },
        ],
      })

      const { result } = yield* call(() =>
        makeRequest(handler, [{ role: 'user', content: 'Hi' }])
      )

      expect(result.error).not.toBeNull()
      expect(result.error?.message).toContain('Provider not configured')
    })
  })

  describe('Session Management', () => {
    it('should return session ID in response headers', function* () {
      const provider = createMockProvider({ responses: 'Hello' })
      const handler = createDurableChatHandler({
        initializerHooks: createTestHooks(provider),
      })

      const { sessionId } = yield* call(() =>
        makeRequest(handler, [{ role: 'user', content: 'Hi' }])
      )

      expect(sessionId).toBeDefined()
      expect(typeof sessionId).toBe('string')
      expect(sessionId?.length).toBeGreaterThan(0)
    })

    it('should return correct content type', function* () {
      const provider = createMockProvider({ responses: 'Hello' })
      const handler = createDurableChatHandler({
        initializerHooks: createTestHooks(provider),
      })

      const { request } = createChatRequest([{ role: 'user', content: 'Hi' }])
      const response = yield* call(() => handler(request))

      expect(response.headers.get('Content-Type')).toBe('application/x-ndjson')
      expect(response.headers.get('Cache-Control')).toBe('no-store')
      expect(response.headers.get('Stream-Next-Offset')).toBeDefined()
      expect(response.headers.get('ETag')).toBeDefined()
    })
  })

  describe('Protocol Alignment', () => {
    it('should support reconnect via /sessions/{id}?offset=N', function* () {
      const provider = createMockProvider({ responses: 'one two three' })
      const handler = createDurableChatHandler({
        initializerHooks: createTestHooks(provider),
      })

      const { sessionId, result: initial } = yield* call(() =>
        makeRequest(handler, [{ role: 'user', content: 'Hi' }])
      )

      const { request } = createChatRequest([], {
        sessionId: sessionId!,
        offset: Math.max(0, initial.lastLSN - 1),
        useSessionPath: true,
      })
      const response = yield* call(() => handler(request))

      expect(response.status).toBe(200)
      expect(response.headers.get('X-Session-Id')).toBe(sessionId)
      expect(response.headers.get('ETag')).toBeDefined()
      expect(response.headers.get('Stream-Next-Offset')).toBeDefined()
    })

    it('should return metadata for HEAD /sessions/{id}', function* () {
      const provider = createMockProvider({ responses: 'head metadata' })
      const handler = createDurableChatHandler({
        initializerHooks: createTestHooks(provider),
      })

      const { request: initialRequest } = createChatRequest([
        { role: 'user', content: 'Hi' },
      ])
      const initialResponse = yield* call(() => handler(initialRequest))
      const sessionId = initialResponse.headers.get('X-Session-Id')
      expect(sessionId).toBeDefined()

      const { request } = createChatRequest([], {
        sessionId: sessionId!,
        useSessionPath: true,
        method: 'HEAD',
      })

      const response = yield* call(() => handler(request))
      expect(response.status).toBe(200)
      expect(response.headers.get('ETag')).toBeDefined()
      expect(response.headers.get('Stream-Next-Offset')).toBeDefined()
      expect(response.headers.get('Cache-Control')).toBe('no-store')

      // Ensure streaming response is cleaned up
      yield* call(async () => {
        await initialResponse.body?.cancel()
      })
    })

    it('should return 304 for If-None-Match when up-to-date', function* () {
      const provider = createMockProvider({ responses: 'etag check' })
      const handler = createDurableChatHandler({
        initializerHooks: createTestHooks(provider),
      })

      const { request: initialRequest } = createChatRequest([
        { role: 'user', content: 'Hi' },
      ])
      const initialResponse = yield* call(() => handler(initialRequest))
      const sessionId = initialResponse.headers.get('X-Session-Id')
      expect(sessionId).toBeDefined()

      const { request: headRequest } = createChatRequest([], {
        sessionId: sessionId!,
        useSessionPath: true,
        method: 'HEAD',
      })
      const headResponse = yield* call(() => handler(headRequest))
      const offset = Number.parseInt(
        headResponse.headers.get('Stream-Next-Offset') ?? '0',
        10,
      )

      const { request: firstReconnect } = createChatRequest([], {
        sessionId: sessionId!,
        offset,
        useSessionPath: true,
      })
      const firstResponse = yield* call(() => handler(firstReconnect))
      const etag = firstResponse.headers.get('ETag')
      expect(etag).toBeDefined()

      const { request: secondReconnect } = createChatRequest([], {
        sessionId: sessionId!,
        offset,
        useSessionPath: true,
      })
      secondReconnect.headers.set('If-None-Match', etag!)

      const secondResponse = yield* call(() => handler(secondReconnect))
      expect(secondResponse.status).toBe(304)

      yield* call(async () => {
        await initialResponse.body?.cancel()
      })
    })

    it('should return 204 for long-poll timeout when up-to-date', function* () {
      const provider = createMockProvider({
        responses: 'slow response',
        tokenDelayMs: 1_000,
      })
      const handler = createDurableChatHandler({
        initializerHooks: createTestHooks(provider),
      })

      const { request: initialRequest } = createChatRequest([
        { role: 'user', content: 'Hi' },
      ])
      const initialResponse = yield* call(() => handler(initialRequest))
      const sessionId = initialResponse.headers.get('X-Session-Id')
      expect(sessionId).toBeDefined()

      const { request: longPollRequest } = createChatRequest([], {
        sessionId: sessionId!,
        useSessionPath: true,
        method: 'HEAD',
      })
      const headResponse = yield* call(() => handler(longPollRequest))
      const tailOffset = Number.parseInt(
        headResponse.headers.get('Stream-Next-Offset') ?? '0',
        10,
      )

      const { request: pollRequest } = createChatRequest([], {
        sessionId: sessionId!,
        useSessionPath: true,
        method: 'GET',
        live: 'long-poll',
        offset: tailOffset,
        timeout: 0,
      })

      const longPollResponse = yield* call(() => handler(pollRequest))
      expect(longPollResponse.status).toBe(204)
      expect(longPollResponse.headers.get('Stream-Up-To-Date')).toBe('true')
      expect(longPollResponse.headers.get('Stream-Cursor')).toBeDefined()

      yield* call(async () => {
        await initialResponse.body?.cancel()
      })
    })

    it('should return 200 for long-poll when backlog data exists', function* () {
      const provider = createMockProvider({ responses: 'long poll backlog' })
      const handler = createDurableChatHandler({
        initializerHooks: createTestHooks(provider),
      })

      const { sessionId } = yield* call(() =>
        makeRequest(handler, [{ role: 'user', content: 'Hi' }])
      )

      const { request: longPollRequest } = createChatRequest([], {
        sessionId: sessionId!,
        useSessionPath: true,
        method: 'GET',
        live: 'long-poll',
        offset: 0,
        timeout: 1,
      })

      const longPollResponse = yield* call(() => handler(longPollRequest))
      expect(longPollResponse.status).toBe(200)
      expect(longPollResponse.headers.get('Stream-Cursor')).toBeDefined()
      expect(longPollResponse.headers.get('Stream-Next-Offset')).toBeDefined()
    })

    it('should stream SSE data and control events', function* () {
      const provider = createMockProvider({ responses: 'sse stream payload' })
      const handler = createDurableChatHandler({
        initializerHooks: createTestHooks(provider),
      })

      const { request: initialRequest } = createChatRequest([
        { role: 'user', content: 'Hi' },
      ])
      const initialResponse = yield* call(() => handler(initialRequest))
      const sessionId = initialResponse.headers.get('X-Session-Id')
      expect(sessionId).toBeDefined()

      const { request } = createChatRequest([], {
        sessionId: sessionId!,
        useSessionPath: true,
        method: 'GET',
        live: 'sse',
        offset: 0,
      })
      const response = yield* call(() => handler(request))

      expect(response.status).toBe(200)
      expect(response.headers.get('Content-Type')).toBe('text/event-stream')

      const body = yield* call(() => response.text())
      expect(body).toContain('event: data')
      expect(body).toContain('event: control')
      expect(body).toContain('streamNextOffset')

      yield* call(async () => {
        await initialResponse.body?.cancel()
      })
    })

    it('should emit streamClosed control event for SSE at closed tail', function* () {
      const provider = createMockProvider({ responses: 'closed stream' })
      const handler = createDurableChatHandler({
        initializerHooks: createTestHooks(provider),
      })

      const { request: initialRequest } = createChatRequest([
        { role: 'user', content: 'Hi' },
      ])
      const initialResponse = yield* call(() => handler(initialRequest))
      const sessionId = initialResponse.headers.get('X-Session-Id')
      expect(sessionId).toBeDefined()

      // Keep one reconnect handle alive so completed session isn't cleaned up.
      const { request: holderRequest } = createChatRequest([], {
        sessionId: sessionId!,
        useSessionPath: true,
        method: 'GET',
        offset: 0,
      })
      const holderResponse = yield* call(() => handler(holderRequest))

      // Drain initial response so writer reaches closed state.
      yield* call(() => initialResponse.text())

      const { request: headRequest } = createChatRequest([], {
        sessionId: sessionId!,
        useSessionPath: true,
        method: 'HEAD',
      })
      const headResponse = yield* call(() => handler(headRequest))
      const tailOffset = Number.parseInt(
        headResponse.headers.get('Stream-Next-Offset') ?? '0',
        10,
      )

      const { request } = createChatRequest([], {
        sessionId: sessionId!,
        useSessionPath: true,
        method: 'GET',
        live: 'sse',
        offset: tailOffset,
      })

      const response = yield* call(() => handler(request))
      const body = yield* call(() => response.text())
      expect(body).toContain('"streamClosed":true')
      expect(body).toContain('"upToDate":true')

      yield* call(async () => {
        await holderResponse.body?.cancel()
      })
    })

    it('should treat offset=-1 as stream beginning', function* () {
      const provider = createMockProvider({ responses: 'offset beginning' })
      const handler = createDurableChatHandler({
        initializerHooks: createTestHooks(provider),
      })

      const { request: initialRequest } = createChatRequest([
        { role: 'user', content: 'Hi' },
      ])
      const initialResponse = yield* call(() => handler(initialRequest))
      const sessionId = initialResponse.headers.get('X-Session-Id')
      expect(sessionId).toBeDefined()

      const { request } = createChatRequest([], {
        sessionId: sessionId!,
        useSessionPath: true,
        method: 'GET',
        offset: -1,
      })
      const response = yield* call(() => handler(request))
      expect(response.status).toBe(200)

      const body = yield* call(() => response.text())
      expect(body).toContain('"lsn":1')

      yield* call(async () => {
        await initialResponse.body?.cancel()
      })
    })

    it('should treat offset=now as current tail for catch-up reads', function* () {
      const provider = createMockProvider({
        responses: 'offset now',
        tokenDelayMs: 1_000,
      })
      const handler = createDurableChatHandler({
        initializerHooks: createTestHooks(provider),
      })

      const { request: initialRequest } = createChatRequest([
        { role: 'user', content: 'Hi' },
      ])
      const initialResponse = yield* call(() => handler(initialRequest))
      const sessionId = initialResponse.headers.get('X-Session-Id')
      expect(sessionId).toBeDefined()

      const nowUrl = new URL(`http://localhost/sessions/${encodeURIComponent(sessionId!)}`)
      nowUrl.searchParams.set('offset', 'now')
      const nowRequest = new Request(nowUrl.toString(), {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
        },
      })

      const response = yield* call(() => handler(nowRequest))
      expect(response.status).toBe(200)
      expect(response.headers.get('Stream-Up-To-Date')).toBe('true')

      const body = yield* call(() => response.text())
      expect(body).toBe('')

      yield* call(async () => {
        await initialResponse.body?.cancel()
      })
    })

    it('should return [] for offset=now with JSON accept header', function* () {
      const provider = createMockProvider({
        responses: 'offset now json',
        tokenDelayMs: 1_000,
      })
      const handler = createDurableChatHandler({
        initializerHooks: createTestHooks(provider),
      })

      const { request: initialRequest } = createChatRequest([
        { role: 'user', content: 'Hi' },
      ])
      const initialResponse = yield* call(() => handler(initialRequest))
      const sessionId = initialResponse.headers.get('X-Session-Id')
      expect(sessionId).toBeDefined()

      const nowUrl = new URL(`http://localhost/sessions/${encodeURIComponent(sessionId!)}`)
      nowUrl.searchParams.set('offset', 'now')
      const nowRequest = new Request(nowUrl.toString(), {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
        },
      })

      const response = yield* call(() => handler(nowRequest))
      expect(response.status).toBe(200)
      expect(response.headers.get('Content-Type')).toBe('application/json')

      const body = yield* call(() => response.text())
      expect(body.trim()).toBe('[]')

      yield* call(async () => {
        await initialResponse.body?.cancel()
      })
    })

    it('should return [] when caught up with JSON accept header', function* () {
      const provider = createMockProvider({ responses: 'already caught up' })
      const handler = createDurableChatHandler({
        initializerHooks: createTestHooks(provider, [], {
          retentionPolicy: { mode: 'retain_forever' },
        }),
      })

      const { sessionId } = yield* call(() =>
        makeRequest(handler, [{ role: 'user', content: 'Hi' }])
      )

      const { request: headRequest } = createChatRequest([], {
        sessionId: sessionId!,
        useSessionPath: true,
        method: 'HEAD',
      })
      const headResponse = yield* call(() => handler(headRequest))
      const tailOffset = headResponse.headers.get('Stream-Next-Offset')
      expect(tailOffset).toBeDefined()

      const { request } = createChatRequest([], {
        sessionId: sessionId!,
        useSessionPath: true,
        method: 'GET',
        offset: Number.parseInt(tailOffset ?? '0', 10),
        requestHeaders: {
          'Accept': 'application/json',
        },
      })

      const response = yield* call(() => handler(request))
      expect(response.status).toBe(200)
      expect(response.headers.get('Content-Type')).toBe('application/json')
      const body = yield* call(() => response.text())
      expect(body.trim()).toBe('[]')
    })

    it('should support protocol-native PUT/POST/DELETE lifecycle on /sessions/{id}', function* () {
      const provider = createMockProvider({ responses: 'unused' })
      const handler = createDurableChatHandler({
        initializerHooks: createTestHooks(provider),
      })

      const sessionId = 'protocol-native-1'
      const sessionUrl = `http://localhost/sessions/${sessionId}`

      const putResponse = yield* call(() => handler(new Request(sessionUrl, {
        method: 'PUT',
      })))
      expect(putResponse.status).toBe(201)
      expect(putResponse.headers.get('Stream-Next-Offset')).toBe('0000000000000000')

      const appendResponse = yield* call(() => handler(new Request(sessionUrl, {
        method: 'POST',
        body: JSON.stringify({ type: 'text', content: 'hello protocol' }),
      })))
      expect(appendResponse.status).toBe(204)
      expect(appendResponse.headers.get('Stream-Next-Offset')).toBe('0000000000000001')

      const closeResponse = yield* call(() => handler(new Request(sessionUrl, {
        method: 'POST',
        headers: {
          'Stream-Closed': 'true',
        },
      })))
      expect(closeResponse.status).toBe(204)
      expect(closeResponse.headers.get('Stream-Closed')).toBe('true')

      const { request: readRequest } = createChatRequest([], {
        sessionId,
        useSessionPath: true,
        method: 'GET',
        offset: 0,
      })
      const readResponse = yield* call(() => handler(readRequest))
      expect(readResponse.status).toBe(200)
      const readBody = yield* call(() => readResponse.text())
      expect(readBody).toContain('hello protocol')

      const deleteResponse = yield* call(() => handler(new Request(sessionUrl, {
        method: 'DELETE',
      })))
      expect(deleteResponse.status).toBe(204)

      const { request: headRequest } = createChatRequest([], {
        sessionId,
        useSessionPath: true,
        method: 'HEAD',
      })
      const headResponse = yield* call(() => handler(headRequest))
      expect(headResponse.status).toBe(404)
    })
  })

  describe('Response Format', () => {
    it('should emit events as NDJSON with LSN', function* () {
      const provider = createMockProvider({ responses: 'Test' })
      const handler = createDurableChatHandler({
        initializerHooks: createTestHooks(provider),
      })

      const { request } = createChatRequest([{ role: 'user', content: 'Hi' }])
      const response = yield* call(() => handler(request))

      // Read raw response
      const text = yield* call(() => response.text())
      const lines = text.trim().split('\n')

      // Each line should be valid JSON with lsn and event
      for (const line of lines) {
        const parsed = JSON.parse(line)
        expect(typeof parsed.lsn).toBe('number')
        expect(parsed.event).toBeDefined()
        expect(typeof parsed.event.type).toBe('string')
      }
    })
  })
})
