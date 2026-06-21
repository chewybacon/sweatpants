/**
 * Test Utilities for Durable Chat Handler
 *
 * Provides:
 * - Mock model provider that simulates LLM responses
 * - Test initializer hooks
 * - Response consumption helpers
 * - DI setup helpers
 */
import { resource, sleep } from 'effection'
import type { Operation, Stream } from 'effection'
import { z } from 'zod'
import type { ChatEvent, ChatResult, Message, ToolCall as ProviderToolCall } from '../../../lib/chat/types.ts'
import { ToolRegistryContext } from '../../../lib/chat/contexts.ts'
import {
  ToolInventoryContext,
  createToolInventory,
  type ToolInventoryEntry,
} from '../../../lib/chat/tool-inventory.ts'
import {
  ToolRuntimeContext,
  createToolExecutionRef,
  type ToolRuntime,
} from '../../../lib/chat/tool-runtime.ts'
import {
  ModelProviderContext,
  ModelProviderModelContext,
  type ModelProviderDriver,
} from '../../../lib/chat/model-provider.ts'
import type {
  AssistantMessage,
  Model,
  Runtime,
  StreamEvent as RuntimeStreamEvent,
  Usage,
} from '../../../lib/chat/runtime/index.ts'
import { setupInMemoryDurableStreams, type DurableStreamsSetup } from '../../../lib/chat/durable-streams/index.ts'
import type { IsomorphicTool, ToolSchema, InitializerHook, DurableStreamEvent } from '../types.ts'
import type { StreamEvent } from '../../types.ts'

// =============================================================================
// MOCK PROVIDER
// =============================================================================

export interface MockProviderStreamOptions {
  model?: string
  baseUri?: string
  apiKey?: string
  toolChoice?: 'auto' | 'none' | 'required'
  schema?: Record<string, unknown>
  isomorphicToolSchemas?: Array<Record<string, unknown>>
}

export interface MockProviderCapabilities {
  thinking: boolean
  toolCalling: boolean
}

export interface MockProvider {
  readonly name: string
  readonly capabilities: MockProviderCapabilities
  stream(messages: Message[], options?: MockProviderStreamOptions): Stream<ChatEvent, ChatResult>
}

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
  customStream?: (messages: Message[], options?: MockProviderStreamOptions) => Stream<ChatEvent, ChatResult>
}

/**
 * Create a mock model provider for testing.
 *
 * By default, responds with "Hello, world!" but can be configured with:
 * - Custom response text
 * - Tool calls
 * - Thinking events
 * - Custom timing
 */
export function createMockProvider(config: MockProviderConfig = {}): MockProvider {
  const {
    responses = 'Hello, world!',
    toolCalls,
    tokenDelayMs = 0,
    emitThinking = false,
    customStream,
  } = config

  let callCount = 0

  const capabilities: MockProviderCapabilities = {
    thinking: emitThinking,
    toolCalling: !!toolCalls,
  }

  return {
    name: 'mock',
    capabilities,

    stream(_messages: Message[], _options?: MockProviderStreamOptions): Stream<ChatEvent, ChatResult> {
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

function testModel(): Model {
  return {
    id: 'mock-model',
    name: 'Mock Model',
    api: 'mock',
    provider: 'mock',
    reasoning: false,
    input: ['text'],
    contextWindow: 128000,
    maxTokens: 4096,
  }
}

function textFromRuntimeContent(content: string | Array<{ type: string; text?: string }>): string {
  return typeof content === 'string'
    ? content
    : content.map((block) => block.type === 'text' ? block.text ?? '' : '').join('')
}

function usageFromProviderUsage(usage: ChatResult['usage']): Usage {
  return {
    input: usage.promptTokens,
    output: usage.completionTokens,
    total: usage.totalTokens,
  }
}

function assistantFromProviderResult(result: ChatResult): AssistantMessage {
  return {
    role: 'assistant',
    content: [
      ...(result.text ? [{ type: 'text' as const, text: result.text }] : []),
      ...(result.thinking ? [{ type: 'thinking' as const, text: result.thinking }] : []),
      ...(result.toolCalls ?? []).map((toolCall) => ({
        type: 'toolCall' as const,
        id: toolCall.id,
        name: toolCall.function.name,
        arguments: toolCall.function.arguments,
      })),
    ],
    usage: usageFromProviderUsage(result.usage),
    stopReason: result.toolCalls && result.toolCalls.length > 0 ? 'toolUse' : 'stop',
  }
}

function providerMessagesFromRuntimeContext(context: Parameters<Runtime['stream']>[1]): Message[] {
  const messages: Message[] = []

  if (context.systemPrompt) {
    messages.push({ id: 'system:runtime', role: 'system', content: context.systemPrompt })
  }

  for (const message of context.messages) {
    if (message.role === 'system') {
      messages.push({ id: `system:${messages.length}`, role: 'system', content: message.content })
    } else if (message.role === 'user') {
      messages.push({ id: `user:${messages.length}`, role: 'user', content: textFromRuntimeContent(message.content) })
    } else if (message.role === 'toolResult') {
      messages.push({
        id: `tool:${message.toolCallId}`,
        role: 'tool',
        content: textFromRuntimeContent(message.content),
        tool_call_id: message.toolCallId,
        replay: { toolName: message.toolName },
      })
    } else {
      const toolCalls: ProviderToolCall[] = message.content
        .filter((block): block is Extract<typeof message.content[number], { type: 'toolCall' }> => block.type === 'toolCall')
        .map((block) => ({
          id: block.id,
          type: 'function',
          function: { name: block.name, arguments: block.arguments },
        }))
      messages.push({
        id: `assistant:${messages.length}`,
        role: 'assistant',
        content: textFromRuntimeContent(message.content),
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      })
    }
  }

  return messages
}

export function createMockModelProviderDriver(provider: MockProvider): ModelProviderDriver {
  return {
    stream(request) {
      return resource(function* (provide) {
        const subscription = yield* provider.stream(providerMessagesFromRuntimeContext(request.context), {
          model: request.model.id,
          ...(request.model.baseUrl ? { baseUri: request.model.baseUrl } : {}),
          ...(request.options?.apiKey ? { apiKey: request.options.apiKey } : {}),
          ...(request.context.tools ? { isomorphicToolSchemas: request.context.tools.map((tool) => ({ ...tool, isIsomorphic: true as const })) } : {}),
          ...(request.options?.toolChoice ? { toolChoice: request.options.toolChoice } : {}),
          ...(request.options?.responseFormat?.schema ? { schema: request.options.responseFormat.schema } : {}),
        })
        const pending: RuntimeStreamEvent[] = []
        let text = ''
        let thinking = ''
        let contentIndex = 0

        yield* provide({
          *next(): Operation<IteratorResult<RuntimeStreamEvent, AssistantMessage>> {
            if (pending.length > 0) return { done: false, value: pending.shift()! }

            const next = yield* subscription.next()
            if (next.done) return { done: true, value: assistantFromProviderResult(next.value) }

            const event: ChatEvent = next.value
            const partial: AssistantMessage = {
              role: 'assistant',
              content: [
                ...(text ? [{ type: 'text' as const, text }] : []),
                ...(thinking ? [{ type: 'thinking' as const, text: thinking }] : []),
              ],
            }

            if (event.type === 'text') {
              text += event.content
              return { done: false, value: { type: 'text_delta', contentIndex: 0, delta: event.content, partial } }
            }

            if (event.type === 'thinking') {
              thinking += event.content
              return { done: false, value: { type: 'thinking_delta', contentIndex: 1, delta: event.content, partial } }
            }

            for (const toolCall of event.toolCalls) {
              pending.push({
                type: 'toolcall_end',
                contentIndex: contentIndex++,
                toolCall: {
                  type: 'toolCall',
                  id: toolCall.id,
                  name: toolCall.function.name,
                  arguments: toolCall.function.arguments,
                },
                partial,
              })
            }

            return yield* this.next()
          },
        })
      })
    },
    *sample(request): Operation<AssistantMessage> {
      const subscription = yield* this.stream(request)
      while (true) {
        const next = yield* subscription.next()
        if (next.done) return next.value
      }
    },
  }
}

export function* setupMockModelProvider(provider: MockProvider): Operation<void> {
  yield* ModelProviderContext.set(createMockModelProviderDriver(provider))
  yield* ModelProviderModelContext.set(testModel())
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

function toolEntry(tool: IsomorphicTool): ToolInventoryEntry<IsomorphicTool> {
  return {
    definition: {
      name: tool.name,
      description: tool.description,
      parameters: z.toJSONSchema(tool.parameters),
    },
    implementation: tool,
    capabilities: {
      inline: !!tool.server,
      client: !!tool.client,
    },
  }
}

function createTestToolRuntime(tools: IsomorphicTool[]): ToolRuntime {
  const byName = new Map(tools.map((tool) => [tool.name, tool] as const))
  return {
    id: 'test',
    *execute(request) {
      const tool = byName.get(request.call.function.name)
      const ref = createToolExecutionRef({ runtimeId: 'test', callId: request.call.id, toolName: request.call.function.name })
      if (!tool) return { kind: 'failed', ref, error: { code: 'TOOL_NOT_FOUND', message: `Tool not found: ${request.call.function.name}` } }
      const params = tool.parameters.parse(request.call.function.arguments)
      if (!tool.server) {
        if (tool.client) return { kind: 'awaiting_client', ref, request: { params, usesHandoff: false } }
        return { kind: 'failed', ref, error: { code: 'TOOL_NOT_EXECUTABLE', message: `Tool not executable: ${tool.name}` } }
      }
      try {
        const serverOutput = yield* tool.server(params, { callId: request.call.id, signal: request.signal ?? new AbortController().signal })
        if (tool.client) return { kind: 'awaiting_client', ref, request: { params, serverOutput, usesHandoff: true } }
        return { kind: 'completed', ref, result: serverOutput }
      } catch (error) {
        return { kind: 'failed', ref, error: { code: 'TOOL_ERROR', message: error instanceof Error ? error.message : String(error) } }
      }
    },
    *resume(request) {
      return { kind: 'failed', ref: request.ref, error: { code: 'EXECUTION_NOT_FOUND', message: `Execution not found: ${request.ref.executionId}` } }
    },
    *abort() {},
  }
}

export function* setupMockTools(tools: IsomorphicTool[]): Operation<void> {
  yield* ToolRegistryContext.set(tools)
  yield* ToolInventoryContext.set(createToolInventory(tools.map(toolEntry)))
  yield* ToolRuntimeContext.set(createTestToolRuntime(tools))
}

/**
 * Create initializer hooks for testing with a mock provider and tools.
 */
export function createTestInitializerHooks(
  provider: MockProvider,
  tools: IsomorphicTool[] = []
): InitializerHook[] {
  return [
    function* setupProvider() {
      yield* setupMockModelProvider(provider)
    },
    function* setupTools() {
      yield* setupMockTools(tools)
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
 * Complete event from stream (AG-UI run finished).
 */
export interface CompleteEvent {
  type: 'ag_ui_run_finished'
  run: { threadId: string; runId: string }
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

export function getEventsByType(
  result: DurableResponseResult,
  type: string,
): StreamEvent[] {
  return result.events
    .map((entry) => entry.event)
    .filter((event) => {
      const candidate = event as { type?: string }
      return candidate.type === type
    })
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
      case 'ag_ui_text_message_content':
        text += e.delta
        break
      case 'thinking':
        thinking += e.content
        break
      case 'ag_ui_tool_call_start':
        if (!toolCalls) {
          toolCalls = []
        }
        toolCalls.push({ id: e.toolCallId, name: e.toolCallName, arguments: undefined })
        break
      case 'ag_ui_tool_call_args': {
        const existing = toolCalls?.find((tc) => tc.id === e.toolCallId)
        if (existing) {
          try {
            existing.arguments = JSON.parse(e.delta)
          } catch {
            existing.arguments = e.delta
          }
        }
        break
      }
      case 'ag_ui_tool_call_result':
        toolResults.push({ id: e.toolCallId, name: e.toolCallName, content: e.content })
        break
      case 'isomorphic_handoff':
        handoffs.push(e as HandoffEvent)
        break
      case 'ag_ui_run_finished':
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
    conversationId?: string
    lastLSN?: number
    offset?: number
    useSessionPath?: boolean
    method?: 'POST' | 'HEAD' | 'GET'
    live?: 'long-poll' | 'sse'
    timeout?: number
    requestHeaders?: Record<string, string>
    persona?: string
    enabledTools?: boolean | string[]
    enabledPlugins?: string[]
    systemPrompt?: string
    isomorphicTools?: ToolSchema[]
  } = {}
): { request: Request; body: Record<string, unknown> } {
  const {
    sessionId,
    conversationId,
    lastLSN,
    offset,
    useSessionPath,
    method,
    live,
    timeout,
    requestHeaders,
    ...bodyOptions
  } = options
  const effectiveMethod = method ?? (useSessionPath ? 'GET' : 'POST')
  const body = { messages, ...bodyOptions }

  const headers = new Headers({
    'Content-Type': 'application/json',
  })

  if (requestHeaders) {
    for (const [key, value] of Object.entries(requestHeaders)) {
      headers.set(key, value)
    }
  }

  const basePath = useSessionPath && sessionId
    ? `http://localhost/sessions/${encodeURIComponent(sessionId)}`
    : 'http://localhost/chat'
  const url = new URL(basePath)

  if (sessionId && !useSessionPath) {
    url.searchParams.set('sessionId', sessionId)
  }

  if (conversationId) {
    url.searchParams.set('conversationId', conversationId)
  }

  if (offset !== undefined) {
    url.searchParams.set('offset', String(offset))
  } else if (lastLSN !== undefined) {
    url.searchParams.set('offset', String(lastLSN))
  }

  if (live) {
    url.searchParams.set('live', live)
  }

  if (timeout !== undefined) {
    url.searchParams.set('timeout', String(timeout))
  }

  if (effectiveMethod === 'HEAD' || effectiveMethod === 'GET') {
    const request = new Request(url.toString(), {
      method: effectiveMethod,
      headers,
    })

    return { request, body }
  }

  const request = new Request(url.toString(), {
    method: effectiveMethod,
    headers,
    body: JSON.stringify(body),
  })

  return { request, body }
}
