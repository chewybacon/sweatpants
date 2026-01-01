import type { Operation, Stream, Subscription } from 'effection'
import { resource, call, useAbortSignal } from 'effection'
import { parseSSE } from '../sse'
import { resolveChatStreamConfig, type ResolvedChatStreamConfig } from './config'
import type {
  Message,
  ChatEvent,
  ChatResult,
  TokenUsage,
  ToolCall,
} from '../types'
import type { ChatProvider, ChatStreamOptions } from './types'



interface OpenAIFunctionTool {
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
 *
 * IMPORTANT: This function must preserve tool_calls and tool_call_id
 * so that multi-turn tool conversations work correctly.
 */
export function toOpenAIInput(messages: Message[]): OpenAIInputItem[] {
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
    messages: Message[],
    options?: ChatStreamOptions
  ): Stream<ChatEvent, ChatResult> {
    return resource(function*(provide) {
      const signal = yield* useAbortSignal()
      const values: ResolvedChatStreamConfig = yield* resolveChatStreamConfig(options, {
        baseUri: process.env['OPENAI_BASE_URL'] ?? 'https://api.openai.com/v1',
        model: process.env['OPENAI_MODEL'] ?? 'gpt-5-chat-latest',
        envApiKeyName: 'OPENAI_API_KEY',
      })

      // If no API key is provided via context, try environment (common for server-side)
      const resolvedApiKey = values.apiKey ?? process.env['OPENAI_API_KEY']
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
        values.isomorphicToolSchemas ?? []
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

      const url = `${values.baseUri.replace(/\/$/, '')}/responses`

      const response = yield* call(() =>
        fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${resolvedApiKey}`,
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

      // In Node.js, response.body might be a Node.js Readable, not a Web ReadableStream
      let readableStream: ReadableStream<Uint8Array>
      if (response.body instanceof ReadableStream) {
        readableStream = response.body
      } else {
        // Convert Node.js Readable to Web ReadableStream
        const nodeStream = response.body as any
        readableStream = new ReadableStream({
          start(controller) {
            nodeStream.on('data', (chunk: Buffer) => {
              controller.enqueue(new Uint8Array(chunk))
            })
            nodeStream.on('end', () => {
              controller.close()
            })
            nodeStream.on('error', (err: Error) => {
              controller.error(err)
            })
          }
        })
      }

      const sseStream = parseSSE(readableStream)
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
                ...(thinkingBuffer ? { thinking: thinkingBuffer } : {}),
                ...(toolCalls.length > 0 ? { toolCalls } : {}),
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
              const delta = event['delta']
              const textDelta = typeof delta === 'string' ? delta : (delta as any)?.text || ''
              if (textDelta) {
                textBuffer += textDelta
                pendingEvents.push({ type: 'text', content: textDelta })
              }
              break
            }

            // Reasoning summary text (for "thinking" UI)
            case 'response.reasoning_summary_text.delta': {
              const delta = event['delta']
              const textDelta = typeof delta === 'string' ? delta : (delta as any)?.text || ''
              if (textDelta) {
                thinkingBuffer += textDelta
                pendingEvents.push({ type: 'thinking', content: textDelta })
              }
              break
            }

            // Function call output item added - start tracking
            case 'response.output_item.added': {
              const item = event['item'] as {
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
              const itemId = event['item_id'] as string
              const delta = event['delta']
              const textDelta = typeof delta === 'string' ? delta : (delta as any)?.text || ''
              const pending = pendingFunctionCalls.get(itemId)
              if (pending && textDelta) {
                pending.arguments += textDelta
              }
              break
            }

            // Function call arguments done - finalize and emit
            case 'response.function_call_arguments.done': {
              const itemId = event['item_id'] as string
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
              const respUsage = event['response']?.usage as {
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
              const message = event['message'] as string
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
