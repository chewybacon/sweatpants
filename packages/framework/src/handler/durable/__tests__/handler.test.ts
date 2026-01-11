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
import { setupInMemoryDurableStreams } from '../../../lib/chat/durable-streams/index.ts'
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
  tools: IsomorphicTool[] = []
): InitializerHook[] {
  return [
    // Set up durable streams infrastructure
    function* setupDurableStreams() {
      yield* setupInMemoryDurableStreams<string>()
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
            yield* setupInMemoryDurableStreams<string>()
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
      expect(response.headers.get('Cache-Control')).toBe('no-cache')
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
