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
import { z } from 'zod'
import {
  createInMemoryBufferStore,
  createInMemoryRegistryStore,
  setupDurableStreams,
} from '../../../lib/chat/durable-streams/index.ts'
import type { RetentionPolicy } from '@sweatpants/durable-streams'
import { createDurableChatHandler } from '../handler.ts'
import type { ChatHandlerSetup } from '../types.ts'
type LegacyTestTool = any
import type { Message } from '../../../lib/chat/types.ts'
import {
  createMockProvider,
  createMockTool,
  consumeDurableResponse,
  createChatRequest,
  getEventsByType,
  setupMockModelProvider,
  setupMockTools,
} from './test-utils.ts'

// =============================================================================
// TEST HELPERS
// =============================================================================

/**
 * Create request setup for testing.
 */
function createTestHooks(
  provider: ReturnType<typeof createMockProvider>,
  tools: LegacyTestTool[] = [],
  options: { retentionPolicy?: RetentionPolicy } = {}
): ChatHandlerSetup {
  const bufferStore = createInMemoryBufferStore<string>()
  const registryStore = createInMemoryRegistryStore()

  return function* setup() {
    yield* setupDurableStreams({
      bufferStore,
      registryStore,
      ...(options.retentionPolicy ? { retentionPolicy: options.retentionPolicy } : {}),
    })
    yield* setupMockModelProvider(provider)
    yield* setupMockTools(tools)
  }
}

/**
 * Helper to make a chat request and consume the response.
 */
async function makeRequest(
  handler: (req: Request) => Promise<Response>,
  messages: Message[],
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
    it('should replay prior user and assistant state for conversationId GET', function* () {
      const provider = createMockProvider({ responses: 'Hello from durable world' })
      const handler = createDurableChatHandler({
        setup: createTestHooks(provider, [], {
          retentionPolicy: { mode: 'retain_forever' },
        }),
      })

      const conversationId = 'durable-plain-thread'

      yield* call(() =>
        makeRequest(handler, [{ id: 'user:durable-handler', role: 'user', content: 'Hi durable handler' }], {
          conversationId,
        }),
      )

      const { request } = createChatRequest([], {
        method: 'GET',
        conversationId,
      })
      const response = yield* call(() => handler(request))
      const replay = yield* call(() => consumeDurableResponse(response))

      const checkpoints = getEventsByType(replay, 'ag_ui_checkpoint') as Array<{
        type: 'ag_ui_checkpoint'
        checkpoint: {
          messages: {
            messages: Array<{ role: string; content: string }>
          }
        }
      }>

      expect(checkpoints.length).toBeGreaterThan(0)
      expect(checkpoints[0]?.checkpoint.messages.messages).toMatchObject([
        { role: 'user', content: 'Hi durable handler' },
      ])
      expect(replay.text).toContain('Hello from durable world')
    })

    it('should reuse the same durable session for repeated conversationId requests', function* () {
      const provider = createMockProvider({ responses: ['First response', 'Second response'] })
      const handler = createDurableChatHandler({
        setup: createTestHooks(provider, [], {
          retentionPolicy: { mode: 'retain_forever' },
        }),
      })

      const conversationId = 'thread-123'

      const first = yield* call(() =>
        makeRequest(handler, [{ id: 'user:hello', role: 'user', content: 'Hello' }], {
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

      const replayResult = yield* call(() => consumeDurableResponse(replayResponse))
      expect(replayResult.text).toContain('First response')

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
        setup: createTestHooks(provider),
      })

      const { result, sessionId } = yield* call(() =>
        makeRequest(handler, [{ id: 'user:hi', role: 'user', content: 'Hi' }])
      )

      // Should have session ID
      expect(sessionId).toBeDefined()

      // Should have session info event
      expect(result.sessionInfo).not.toBeNull()
      expect(result.sessionInfo?.type).toBe('session_info')
      expect(result.sessionInfo?.capabilities.streaming).toBe(true)

      // Should have text
      expect(result.text).toBe('Hello, world!')

      // Should have complete event (ag_ui_run_finished)
      expect(result.complete).not.toBeNull()
      expect(result.complete?.type).toBe('ag_ui_run_finished')

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
        setup: createTestHooks(provider),
      })

      const { result } = yield* call(() =>
        makeRequest(handler, [{ id: 'user:count', role: 'user', content: 'Count' }])
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
        setup: createTestHooks(provider, [echoTool]),
        maxToolIterations: 1,
      })

      const { result } = yield* call(() =>
        makeRequest(handler, [{ id: 'user:echo', role: 'user', content: 'Echo something' }], {
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

    it('should reject invalid tool parameters before server execution', function* () {
      let serverCalls = 0
      const routeTool: LegacyTestTool = {
        name: 'book_flight',
        description: 'Book a flight',
        parameters: z.object({ from: z.string(), destination: z.string() }),
        server: function* (params: unknown) {
          serverCalls++
          return { route: params }
        },
      }
      let providerCalls = 0
      const provider = createMockProvider({
        customStream: (messages, options) => {
          const idx = providerCalls++
          if (idx === 0) {
            return createMockProvider({
              responses: 'Calling tool',
              toolCalls: [{ id: 'call-missing-from', name: 'book_flight', arguments: { destination: 'NYC' } }],
            }).stream(messages, options)
          }
          return createMockProvider({ responses: 'Where are you flying from?' }).stream(messages, options)
        },
      })
      const handler = createDurableChatHandler({
        setup: createTestHooks(provider, [routeTool]),
        maxToolIterations: 2,
      })

      const { result } = yield* call(() =>
        makeRequest(handler, [{ id: 'user:flight', role: 'user', content: 'I want to fly to NYC' }], {
          enabledTools: true,
        })
      )

      const toolErrors = getEventsByType(result, 'ag_ui_tool_call_error') as Array<{
        type: 'ag_ui_tool_call_error'
        toolCallId: string
        toolCallName: string
        message: string
        error?: { code?: string; issues?: Array<{ path: Array<string | number> }> }
      }>

      expect(serverCalls).toBe(0)
      expect(result.toolResults).toBeNull()
      expect(toolErrors).toHaveLength(1)
      expect(toolErrors[0]).toMatchObject({
        toolCallId: 'call-missing-from',
        toolCallName: 'book_flight',
      })
      expect(toolErrors[0]?.error?.code).toBe('TOOL_PARAMETER_VALIDATION_FAILED')
      expect(toolErrors[0]?.error?.issues?.some((issue) => issue.path.includes('from'))).toBe(true)
    })

    it('should reconcile unique generated tool-name aliases before execution', function* () {
      const generatedTool = createMockTool('book-flight_book_flight', 'Books a flight')
      const provider = createMockProvider({
        responses: 'I will book that',
        toolCalls: [{ id: 'call-1', name: 'book-flight', arguments: { input: 'NYC to LAX' } }],
      })
      const handler = createDurableChatHandler({
        setup: createTestHooks(provider, [generatedTool]),
        maxToolIterations: 1,
      })

      const { result } = yield* call(() =>
        makeRequest(handler, [{ id: 'user:alias-tool', role: 'user', content: 'Book a flight' }], {
          enabledTools: true,
        })
      )

      expect(result.toolCalls?.[0]?.name).toBe('book-flight_book_flight')
      expect(result.toolResults?.[0]?.name).toBe('book-flight_book_flight')
      expect(result.toolResults?.[0]?.content).toContain('Mock result for: NYC to LAX')
    })

    it('should finish cleanly when provider tool calls do not match any supported tool', function* () {
      const echoTool = createMockTool('echo', 'Echoes input')
      const provider = createMockProvider({
        responses: '',
        toolCalls: [{ id: 'call-unsupported', name: 'unsupported_tool', arguments: { input: 'hello' } }],
      })
      const handler = createDurableChatHandler({
        setup: createTestHooks(provider, [echoTool]),
        maxToolIterations: 1,
      })

      const { result } = yield* call(() =>
        makeRequest(handler, [{ id: 'user:unsupported-tool', role: 'user', content: 'Call an unsupported tool' }], {
          enabledTools: true,
        })
      )

      expect(result.error).toBeNull()
      expect(result.toolCalls).toBeNull()
      expect(result.toolResults).toBeNull()
      expect(result.complete).not.toBeNull()
    })

    it('should emit AG-UI tool lifecycle events for server-side tools', function* () {
      const echoTool = createMockTool('echo', 'Echoes input')
      const provider = createMockProvider({
        responses: 'Let me echo that',
        toolCalls: [{ id: 'call-1', name: 'echo', arguments: { input: 'hello' } }],
      })
      const handler = createDurableChatHandler({
        setup: createTestHooks(provider, [echoTool]),
        maxToolIterations: 1,
      })

      const { result } = yield* call(() =>
        makeRequest(handler, [{ id: 'user:u1', role: 'user', content: 'Echo something' }], {
          conversationId: 'thread-ag-ui-server-tool',
          enabledTools: true,
        })
      )

      const toolStartEvents = getEventsByType(result, 'ag_ui_tool_call_start') as Array<{
        type: 'ag_ui_tool_call_start'
        toolCallId: string
        toolCallName: string
      }>
      const toolArgEvents = getEventsByType(result, 'ag_ui_tool_call_args') as Array<{
        type: 'ag_ui_tool_call_args'
        toolCallId: string
        delta: string
      }>
      const toolEndEvents = getEventsByType(result, 'ag_ui_tool_call_end') as Array<{
        type: 'ag_ui_tool_call_end'
        toolCallId: string
      }>

      expect(toolStartEvents).toEqual([
        {
          type: 'ag_ui_tool_call_start',
          toolCallId: 'call-1',
          toolCallName: 'echo',
          parentMessageId: 'assistant:tools:call-1',
        },
      ])
      expect(toolArgEvents).toEqual([
        {
          type: 'ag_ui_tool_call_args',
          toolCallId: 'call-1',
          delta: JSON.stringify({ input: 'hello' }),
        },
      ])
      expect(toolEndEvents).toEqual([
        {
          type: 'ag_ui_tool_call_end',
          toolCallId: 'call-1',
        },
      ])
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
        setup: createTestHooks(provider),
      })

      const { result } = yield* call(() =>
        makeRequest(handler, [{ id: 'user:hi', role: 'user', content: 'Hi' }])
      )

      // Should have error event
      expect(result.error).not.toBeNull()
      expect(result.error?.message).toContain('Provider error')
    })

    it('should reject mismatched continuation refs before runtime resume', function* () {
      const echoTool = createMockTool('echo', 'Echoes input')
      const provider = createMockProvider({ responses: 'after mismatch' })
      const handler = createDurableChatHandler({
        setup: createTestHooks(provider, [echoTool]),
      })

      const request = new Request('http://localhost/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [
            { id: 'user:1', role: 'user', content: 'run echo' },
            {
              id: 'assistant:1',
              role: 'assistant',
              content: '',
              tool_calls: [
                { id: 'call-1', type: 'function', function: { name: 'echo', arguments: { input: 'hello' } } },
              ],
            },
          ],
          elicitResponses: [
            {
              sessionId: 'call-1',
              callId: 'call-1',
              toolName: 'echo',
              elicitId: 'elicit-1',
              ref: { runtimeId: 'wrong', executionId: 'call-1', sessionId: 'call-1', callId: 'call-1', toolName: 'echo' },
              result: { action: 'accept', content: { ok: true } },
            },
          ],
        }),
      })

      const response = yield* call(() => handler(request))
      const result = yield* call(() => consumeDurableResponse(response))
      const sessionErrors = result.events
        .map((entry) => entry.event)
        .filter((event): event is { type: 'tool_session_error'; message: string } => (event as { type?: string }).type === 'tool_session_error')
      expect(sessionErrors.some((event) => event.message.includes('Continuation ref mismatch: runtimeId'))).toBe(true)
    })

    it('should emit error when provider is not configured', function* () {
      const handler = createDurableChatHandler({
        setup: function* () {
          // Only setup durable streams, no provider
          const bufferStore = createInMemoryBufferStore<string>()
          const registryStore = createInMemoryRegistryStore()
          yield* setupDurableStreams({ bufferStore, registryStore })
        },
      })

      const { result } = yield* call(() =>
        makeRequest(handler, [{ id: 'user:hi', role: 'user', content: 'Hi' }])
      )

      expect(result.error).not.toBeNull()
      expect(result.error?.message).toContain('Model provider not configured')
    })
  })

  describe('Session Management', () => {
    it('should return session ID in response headers', function* () {
      const provider = createMockProvider({ responses: 'Hello' })
      const handler = createDurableChatHandler({
        setup: createTestHooks(provider),
      })

      const { sessionId } = yield* call(() =>
        makeRequest(handler, [{ id: 'user:hi', role: 'user', content: 'Hi' }])
      )

      expect(sessionId).toBeDefined()
      expect(typeof sessionId).toBe('string')
      expect(sessionId?.length).toBeGreaterThan(0)
    })

    it('should return correct content type', function* () {
      const provider = createMockProvider({ responses: 'Hello' })
      const handler = createDurableChatHandler({
        setup: createTestHooks(provider),
      })

      const { request } = createChatRequest([{ id: 'user:hi', role: 'user', content: 'Hi' }])
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
        setup: createTestHooks(provider),
      })

      const { sessionId, result: initial } = yield* call(() =>
        makeRequest(handler, [{ id: 'user:hi', role: 'user', content: 'Hi' }])
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
        setup: createTestHooks(provider),
      })

      const { request: initialRequest } = createChatRequest([
        { id: 'user:hi', role: 'user', content: 'Hi' },
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
        setup: createTestHooks(provider),
      })

      const { request: initialRequest } = createChatRequest([
        { id: 'user:hi', role: 'user', content: 'Hi' },
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
        setup: createTestHooks(provider),
      })

      const { request: initialRequest } = createChatRequest([
        { id: 'user:hi', role: 'user', content: 'Hi' },
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
        setup: createTestHooks(provider),
      })

      const { sessionId } = yield* call(() =>
        makeRequest(handler, [{ id: 'user:hi', role: 'user', content: 'Hi' }])
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
        setup: createTestHooks(provider),
      })

      const { request: initialRequest } = createChatRequest([
        { id: 'user:hi', role: 'user', content: 'Hi' },
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
        setup: createTestHooks(provider),
      })

      const { request: initialRequest } = createChatRequest([
        { id: 'user:hi', role: 'user', content: 'Hi' },
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
        setup: createTestHooks(provider),
      })

      const { request: initialRequest } = createChatRequest([
        { id: 'user:hi', role: 'user', content: 'Hi' },
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
        setup: createTestHooks(provider),
      })

      const { request: initialRequest } = createChatRequest([
        { id: 'user:hi', role: 'user', content: 'Hi' },
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
        setup: createTestHooks(provider),
      })

      const { request: initialRequest } = createChatRequest([
        { id: 'user:hi', role: 'user', content: 'Hi' },
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
        setup: createTestHooks(provider, [], {
          retentionPolicy: { mode: 'retain_forever' },
        }),
      })

      const { sessionId } = yield* call(() =>
        makeRequest(handler, [{ id: 'user:hi', role: 'user', content: 'Hi' }])
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
        setup: createTestHooks(provider),
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
        setup: createTestHooks(provider),
      })

      const { request } = createChatRequest([{ id: 'user:hi', role: 'user', content: 'Hi' }])
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

    it('should emit ag_ui_checkpoint for durable thread hydration', function* () {
      const provider = createMockProvider({ responses: 'Test' })
      const handler = createDurableChatHandler({
        setup: createTestHooks(provider),
      })

      const { request } = createChatRequest([{ id: 'user:u1', role: 'user', content: 'Hi' }], {
        conversationId: 'thread-ag-ui-checkpoint',
      })
      const response = yield* call(() => handler(request))
      const text = yield* call(() => response.text())
      const events = text.trim().split('\n').map((line) => JSON.parse(line).event)

      expect(events.some((event) => event.type === 'ag_ui_checkpoint')).toBe(true)
    })

    it('should emit AG-UI run, message, and state events for threaded requests', function* () {
      const provider = createMockProvider({ responses: 'Hello there' })
      const handler = createDurableChatHandler({
        setup: createTestHooks(provider),
      })

      const { request } = createChatRequest([{ id: 'user:u1', role: 'user', content: 'Hi' }], {
        conversationId: 'thread-ag-ui-events',
      })
      const response = yield* call(() => handler(request))
      const text = yield* call(() => response.text())
      const events = text.trim().split('\n').map((line) => JSON.parse(line).event)

      expect(events.some((event) => event.type === 'ag_ui_run_started')).toBe(true)
      expect(events.some((event) => event.type === 'ag_ui_messages_snapshot')).toBe(true)
      expect(events.some((event) => event.type === 'ag_ui_state_snapshot')).toBe(true)
      expect(events.some((event) => event.type === 'ag_ui_text_message_start')).toBe(true)
      expect(events.some((event) => event.type === 'ag_ui_text_message_content')).toBe(true)
      expect(events.some((event) => event.type === 'ag_ui_text_message_end')).toBe(true)
    })
  })
})
