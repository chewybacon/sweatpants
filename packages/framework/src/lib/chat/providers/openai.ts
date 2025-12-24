import type { Operation, Stream, Subscription } from 'effection'
import { resource, call, useAbortSignal } from 'effection'
import { parseSSE } from '../sse'
import { ChatStreamConfigContext, ChatApiKeyContext } from './contexts.ts'
import type {
  OllamaMessage,
  ChatEvent,
  ChatResult,
  TokenUsage,
  ToolCall,
} from '../types'
import type { ChatProvider, ChatStreamOptions } from './types'

type OpenAIFunctionTool = {
  type: 'function'
  name: string
  description: string
  parameters: Record<string, unknown>
  strict: boolean
}

// --- OpenAI Responses API Types ---

interface OpenAIInputMessage {
  role: 'user' | 'assistant' | 'system'
  content: string | OpenAIContentPart[]
}

interface OpenAIFunctionCallItem {
  type: 'function_call'
  call_id: string
  name: string
  arguments: string // JSON string
}

interface OpenAIFunctionCallOutputItem {
  type: 'function_call_output'
  call_id: string
  output: string
}

type OpenAIInputItem =
  | OpenAIInputMessage
  | OpenAIFunctionCallItem
  | OpenAIFunctionCallOutputItem

interface OpenAIContentPart {
  type: 'input_text' | 'output_text'
  text: string
}

interface OpenAIResponsesRequest {
  model: string
  input: OpenAIInputItem[]
  tools?: OpenAIFunctionTool[]
  stream: boolean
  store?: boolean
}

// Streaming event types we care about
interface OpenAIStreamEvent {
  type: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any
}

// Tracking state for function calls being built up
interface PendingFunctionCall {
  itemId: string
  callId: string
  name: string
  arguments: string
}

/**
 * Convert our internal message format to OpenAI Responses API input items.
 *
 * The Responses API uses a different format:
 * - Messages with role (user/assistant/system)
 * - function_call items for tool invocations
 * - function_call_output items for tool results
 */
function toOpenAIInput(messages: OllamaMessage[]): OpenAIInputItem[] {
  const items: OpenAIInputItem[] = []

  for (const m of messages) {
    if (m.role === 'system') {
      items.push({ role: 'system', content: m.content })
    } else if (m.role === 'user') {
      items.push({ role: 'user', content: m.content })
    } else if (m.role === 'assistant') {
      // Add assistant message if there's content
      if (m.content) {
        items.push({ role: 'assistant', content: m.content })
      }
      // Add function_call items for any tool calls
      if (m.tool_calls) {
        for (const tc of m.tool_calls) {
          items.push({
            type: 'function_call',
            call_id: tc.id,
            name: tc.function.name,
            arguments: JSON.stringify(tc.function.arguments),
          })
        }
      }
    } else if (m.role === 'tool') {
      // Tool results become function_call_output items
      if (m.tool_call_id) {
        items.push({
          type: 'function_call_output',
          call_id: m.tool_call_id,
          output: m.content,
        })
      }
    }
  }

  return items
}

/**
 * OpenAI Responses API provider implementation
 */
export const openaiProvider: ChatProvider = {
  name: 'openai',

  capabilities: {
    thinking: true, // We'll map reasoning_summary_text events
    toolCalling: true,
  },

  stream(
    messages: OllamaMessage[],
    options?: ChatStreamOptions
  ): Stream<ChatEvent, ChatResult> {
    return resource(function*(provide) {
      const signal = yield* useAbortSignal()
        const config =
          options ??
          (yield* ChatStreamConfigContext.get()) ?? {
            apiUrl: process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
            model: process.env.OPENAI_MODEL ?? 'gpt-4o-mini',
            isomorphicToolSchemas: [],
          }
      const OPENAI_API_KEY = yield* ChatApiKeyContext.expect()

      const defaultApiUrl = process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1'
      const defaultModel = process.env.OPENAI_MODEL ?? 'gpt-4o-mini'

      const resolvedConfig = {
        apiUrl: config?.apiUrl ?? defaultApiUrl,
        model: config?.model ?? defaultModel,
        isomorphicToolSchemas: config?.isomorphicToolSchemas ?? [],
      }

      const values = {
        isomorphicToolSchemas: (
          options?.isomorphicToolSchemas ??
          resolvedConfig.isomorphicToolSchemas
        ),
        model: (options?.model ?? resolvedConfig.model),
        apiUrl: (options?.apiUrl ?? resolvedConfig.apiUrl),
      }

      // If no API key is provided via context, try environment (common for server-side)
      const resolvedApiKey = OPENAI_API_KEY ?? process.env.OPENAI_API_KEY
      if (!resolvedApiKey) {
        throw new Error('OpenAI API key is required. Provide via ChatApiKeyContext or OPENAI_API_KEY env var.')
      }

      const request: OpenAIResponsesRequest = {
        model: values.model,
        input: toOpenAIInput(messages),
        stream: true,
        store: false, // Don't store responses
      }

      // Add tools to request
      const allTools: OpenAIFunctionTool[] = (
        options?.isomorphicToolSchemas ?? []
      ).map((schema) => ({
        type: 'function' as const,
        name: schema.name,
        description: schema.description,
        parameters: {
          ...schema.parameters,
          additionalProperties: false,
        },
        strict: false,
      }))

      if (allTools.length > 0) {
        request.tools = allTools
      }

      const response = yield* call(() =>
        fetch(`${options?.apiUrl}/responses`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${OPENAI_API_KEY}`,
          },
          body: JSON.stringify(request),
          signal,
        })
      )

      if (!response.ok) {
        const errorText = yield* call(() => response.text())
        throw new Error(`OpenAI API error: ${response.status} - ${errorText}`)
      }
      if (!response.body) {
        throw new Error('No response body')
      }

      const sseStream = parseSSE(response.body)
      const subscription: Subscription<
        { event?: string; data: string },
        void
      > = yield* sseStream

      // Accumulators
      let textBuffer = ''
      let thinkingBuffer = ''
      const toolCalls: ToolCall[] = []
      let usage: TokenUsage = {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
      }

      // Track pending function calls being built up from deltas
      const pendingFunctionCalls = new Map<string, PendingFunctionCall>()

      // Queue of events to yield
      const pendingEvents: ChatEvent[] = []

      yield* provide({
        *next(): Operation<IteratorResult<ChatEvent, ChatResult>> {
          // Yield any pending events first
          if (pendingEvents.length > 0) {
            return { done: false, value: pendingEvents.shift()! }
          }

          // Read next SSE event
          const next = yield* subscription.next()

          if (next.done) {
            // Stream finished, return final result
            return {
              done: true,
              value: {
                text: textBuffer,
                thinking: thinkingBuffer || undefined,
                toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
                usage,
              },
            }
          }

          const sseEvent = next.value

          // Parse the JSON data
          let event: OpenAIStreamEvent
          try {
            event = JSON.parse(sseEvent.data) as OpenAIStreamEvent
          } catch {
            // Skip malformed events
            return yield* this.next()
          }

          // Handle different event types
          switch (event.type) {
            // Text output deltas
            case 'response.output_text.delta': {
              const delta = event.delta as string
              if (delta) {
                textBuffer += delta
                pendingEvents.push({ type: 'text', content: delta })
              }
              break
            }

            // Reasoning summary text (for "thinking" UI)
            case 'response.reasoning_summary_text.delta': {
              const delta = event.delta as string
              if (delta) {
                thinkingBuffer += delta
                pendingEvents.push({ type: 'thinking', content: delta })
              }
              break
            }

            // Function call output item added - start tracking
            case 'response.output_item.added': {
              const item = event.item as {
                type: string
                id: string
                call_id: string
                name: string
              }
              if (item.type === 'function_call') {
                pendingFunctionCalls.set(item.id, {
                  itemId: item.id,
                  callId: item.call_id,
                  name: item.name,
                  arguments: '',
                })
              }
              break
            }

            // Function call arguments delta
            case 'response.function_call_arguments.delta': {
              const itemId = event.item_id as string
              const delta = event.delta as string
              const pending = pendingFunctionCalls.get(itemId)
              if (pending && delta) {
                pending.arguments += delta
              }
              break
            }

            // Function call arguments done - finalize and emit
            case 'response.function_call_arguments.done': {
              const itemId = event.item_id as string
              const pending = pendingFunctionCalls.get(itemId)
              if (pending) {
                // Parse the arguments JSON
                let args: Record<string, unknown> = {}
                try {
                  args = JSON.parse(pending.arguments || '{}')
                } catch {
                  // If parsing fails, use empty object
                }

                const toolCall: ToolCall = {
                  id: pending.callId,
                  function: {
                    name: pending.name,
                    arguments: args,
                  },
                }

                toolCalls.push(toolCall)
                pendingEvents.push({
                  type: 'tool_calls',
                  toolCalls: [toolCall],
                })

                pendingFunctionCalls.delete(itemId)
              }
              break
            }

            // Response completed - extract usage
            case 'response.completed': {
              const respUsage = event.response?.usage as {
                input_tokens?: number
                output_tokens?: number
                total_tokens?: number
              }
              if (respUsage) {
                usage = {
                  promptTokens: respUsage.input_tokens ?? 0,
                  completionTokens: respUsage.output_tokens ?? 0,
                  totalTokens: respUsage.total_tokens ?? 0,
                }
              }
              break
            }

            // Error event
            case 'error': {
              const message = event.message as string
              throw new Error(`OpenAI stream error: ${message}`)
            }

            // Ignore other event types
            default:
              break
          }

          // Return first pending event, or recurse to get next
          if (pendingEvents.length > 0) {
            return { done: false, value: pendingEvents.shift()! }
          }

          return yield* this.next()
        },
      })
    })
  },
}
