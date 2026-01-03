/**
 * Test Utilities for Durable Chat Handler
 *
 * Provides:
 * - Mock ChatProvider that simulates LLM responses
 * - Test initializer hooks
 * - Response consumption helpers
 * - DI setup helpers
 */
import { resource, sleep } from 'effection'
import type { Operation, Stream } from 'effection'
import { z } from 'zod'
import type { ChatEvent, ChatResult, Message } from '../../../lib/chat/types'
import type { ChatProvider, ChatStreamOptions, ProviderCapabilities } from '../../../lib/chat/providers/types'
import { ProviderContext, ToolRegistryContext } from '../../../lib/chat/providers/contexts'
import { setupInMemoryDurableStreams, type DurableStreamsSetup } from '../../../lib/chat/durable-streams'
import type { IsomorphicTool, ToolSchema, InitializerHook, DurableStreamEvent } from '../types'

// =============================================================================
// MOCK PROVIDER
// =============================================================================

export interface MockProviderConfig {
  /** Response text (or sequence for multiple calls) */
  responses?: string | string[]
  /** Tool calls to emit */
  toolCalls?: Array<{
    id: string
    name: string
    arguments: Record<string, unknown>
  }>
  /** Delay between tokens */
  tokenDelayMs?: number
  /** Whether to emit thinking events */
  emitThinking?: boolean
  /** Custom stream function for full control */
  customStream?: (messages: Message[], options?: ChatStreamOptions) => Stream<ChatEvent, ChatResult>
}

/**
 * Create a mock ChatProvider for testing.
 *
 * By default, responds with "Hello, world!" but can be configured with:
 * - Custom response text
 * - Tool calls
 * - Thinking events
 * - Custom timing
 */
export function createMockProvider(config: MockProviderConfig = {}): ChatProvider {
  const {
    responses = 'Hello, world!',
    toolCalls,
    tokenDelayMs = 0,
    emitThinking = false,
    customStream,
  } = config

  let callCount = 0

  const capabilities: ProviderCapabilities = {
    thinking: emitThinking,
    toolCalling: !!toolCalls,
  }

  return {
    name: 'mock',
    capabilities,

    stream(_messages: Message[], _options?: ChatStreamOptions): Stream<ChatEvent, ChatResult> {
      if (customStream) {
        return customStream(_messages, _options)
      }

      const responseText = Array.isArray(responses)
        ? responses[callCount++ % responses.length] ?? responses[0]!
        : responses

      return resource(function* (provide) {
        // Tokenize response
        const words = responseText.split(' ')
        const tokens: string[] = []
        for (let i = 0; i < words.length; i++) {
          tokens.push(i === 0 ? words[i]! : ' ' + words[i])
        }

        let tokenIndex = 0
        let thinkingEmitted = false
        let textEmitted = false

        const mappedToolCalls = toolCalls?.map((tc) => ({
          id: tc.id,
          type: 'function' as const,
          function: {
            name: tc.name,
            arguments: tc.arguments,
          },
        }))

        const result: ChatResult = {
          text: responseText,
          ...(mappedToolCalls && { toolCalls: mappedToolCalls }),
          usage: {
            promptTokens: 10,
            completionTokens: tokens.length,
            totalTokens: 10 + tokens.length,
          },
        }

        yield* provide({
          *next(): Operation<IteratorResult<ChatEvent, ChatResult>> {
            if (tokenDelayMs > 0) {
              yield* sleep(tokenDelayMs)
            }

            // Emit thinking first if enabled
            if (emitThinking && !thinkingEmitted) {
              thinkingEmitted = true
              return {
                done: false,
                value: { type: 'thinking', content: 'Let me think...' },
              }
            }

            // Emit text tokens
            if (tokenIndex < tokens.length) {
              textEmitted = true
              return {
                done: false,
                value: { type: 'text', content: tokens[tokenIndex++]! },
              }
            }

            // Emit tool calls if any
            if (toolCalls && textEmitted) {
              textEmitted = false // Reset for next check
              return {
                done: false,
                value: {
                  type: 'tool_calls',
                  toolCalls: toolCalls.map((tc) => ({
                    id: tc.id,
                    type: 'function' as const,
                    function: {
                      name: tc.name,
                      arguments: tc.arguments,
                    },
                  })),
                },
              }
            }

            // Done
            return { done: true, value: result }
          },
        })
      })
    },
  }
}

// =============================================================================
// MOCK TOOLS
// =============================================================================

/**
 * Create a simple mock tool that returns its input.
 */
export function createMockTool(name: string, description: string = 'A mock tool'): IsomorphicTool {
  return {
    name,
    description,
    parameters: z.object({ input: z.string() }),
    server: function* (params: unknown) {
      const { input } = params as { input: string }
      return `Mock result for: ${input}`
    },
  }
}

/**
 * Create a mock tool with client component (isomorphic handoff).
 */
export function createMockIsomorphicTool(name: string): IsomorphicTool {
  return {
    name,
    description: 'An isomorphic mock tool',
    parameters: z.object({ query: z.string() }),
    authority: 'server',
    server: function* (params: unknown) {
      const { query } = params as { query: string }
      return { serverData: `Server processed: ${query}` }
    },
    client: function* (_input: unknown, _ctx: unknown, _params: unknown) {
      // This would run on client
      return 'Client output'
    },
  }
}

// =============================================================================
// INITIALIZER HOOKS
// =============================================================================

/**
 * Create initializer hooks for testing with a mock provider and tools.
 */
export function createTestInitializerHooks(
  provider: ChatProvider,
  tools: IsomorphicTool[] = []
): InitializerHook[] {
  return [
    function* setupProvider() {
      yield* ProviderContext.set(provider)
    },
    function* setupTools() {
      yield* ToolRegistryContext.set(tools)
    },
  ]
}

// =============================================================================
// RESPONSE HELPERS
// =============================================================================

/**
 * Session info from stream.
 */
export interface SessionInfoEvent {
  type: 'session_info'
  capabilities: { thinking: boolean; streaming: boolean; tools: string[] }
  persona: string | null
}

/**
 * Complete event from stream.
 */
export interface CompleteEvent {
  type: 'complete'
  text: string
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
}

/**
 * Error event from stream.
 */
export interface ErrorEvent {
  type: 'error'
  message: string
  recoverable: boolean
}

/**
 * Isomorphic handoff event from stream.
 */
export interface HandoffEvent {
  type: 'isomorphic_handoff'
  callId: string
  toolName: string
  params: unknown
  serverOutput: unknown
  authority: 'server' | 'client'
  usesHandoff: boolean
}

/**
 * Parsed result from consuming a durable chat response.
 */
export interface DurableResponseResult {
  /** All events with LSN */
  events: DurableStreamEvent[]
  /** Session info event if present */
  sessionInfo: SessionInfoEvent | null
  /** Text accumulated from text events */
  text: string
  /** Thinking text accumulated */
  thinking: string
  /** Tool calls event if present */
  toolCalls: Array<{ id: string; name: string; arguments: unknown }> | null
  /** Tool results */
  toolResults: Array<{ id: string; name: string; content: string }> | null
  /** Handoffs if present */
  handoffs: HandoffEvent[]
  /** Complete event if present */
  complete: CompleteEvent | null
  /** Error event if present */
  error: ErrorEvent | null
  /** Highest LSN seen */
  lastLSN: number
}

/**
 * Consume a Response from the durable chat handler.
 * Parses NDJSON and extracts events.
 */
export async function consumeDurableResponse(response: Response): Promise<DurableResponseResult> {
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  const events: DurableStreamEvent[] = []
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) {
      if (buffer.trim()) {
        events.push(JSON.parse(buffer.trim()))
      }
      break
    }

    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop()!
    for (const line of lines) {
      if (line.trim()) {
        events.push(JSON.parse(line))
      }
    }
  }

  // Extract structured data
  let sessionInfo: SessionInfoEvent | null = null
  let text = ''
  let thinking = ''
  let toolCalls: Array<{ id: string; name: string; arguments: unknown }> | null = null
  const toolResults: Array<{ id: string; name: string; content: string }> = []
  const handoffs: HandoffEvent[] = []
  let complete: CompleteEvent | null = null
  let error: ErrorEvent | null = null
  let lastLSN = 0

  for (const { lsn, event } of events) {
    lastLSN = Math.max(lastLSN, lsn)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const e = event as any

    switch (e.type) {
      case 'session_info':
        sessionInfo = e as SessionInfoEvent
        break
      case 'text':
        text += e.text
        break
      case 'thinking':
        thinking += e.text
        break
      case 'tool_calls':
        toolCalls = e.calls
        break
      case 'tool_result':
        toolResults.push({ id: e.id, name: e.name, content: e.content })
        break
      case 'isomorphic_handoff':
        handoffs.push(e as HandoffEvent)
        break
      case 'complete':
        complete = e as CompleteEvent
        break
      case 'error':
        error = e as ErrorEvent
        break
    }
  }

  return {
    events,
    sessionInfo,
    text,
    thinking,
    toolCalls,
    toolResults: toolResults.length > 0 ? toolResults : null,
    handoffs,
    complete,
    error,
    lastLSN,
  }
}

// =============================================================================
// DI SETUP HELPERS
// =============================================================================

/**
 * Set up durable streams contexts for testing.
 * Returns the setup for additional assertions.
 */
export function* useTestDurableStreams(): Operation<DurableStreamsSetup<string>> {
  return yield* setupInMemoryDurableStreams<string>()
}

// =============================================================================
// REQUEST HELPERS
// =============================================================================

/**
 * Create a chat request body.
 */
export function createChatRequest(
  messages: Message[],
  options: {
    sessionId?: string
    lastLSN?: number
    persona?: string
    enabledTools?: boolean | string[]
    systemPrompt?: string
    isomorphicTools?: ToolSchema[]
  } = {}
): { request: Request; body: Record<string, unknown> } {
  const { sessionId, lastLSN, ...bodyOptions } = options
  const body = { messages, ...bodyOptions }

  const headers = new Headers({
    'Content-Type': 'application/json',
  })

  if (sessionId) {
    headers.set('X-Session-Id', sessionId)
  }
  if (lastLSN !== undefined) {
    headers.set('X-Last-LSN', String(lastLSN))
  }

  const request = new Request('http://localhost/chat', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })

  return { request, body }
}
