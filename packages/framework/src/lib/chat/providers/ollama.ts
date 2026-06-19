import type { Operation, Stream, Subscription } from 'effection'
import { resource, call, useAbortSignal } from 'effection'
import { parseNDJSON } from '../ndjson.ts'
import type {
  OllamaMessage,
  OllamaChatRequest,
  OllamaChatChunk,
  ChatEvent,
  ChatResult,
  TokenUsage,
  ToolCall,
} from '../types.ts'
import type { ChatProvider, ChatStreamOptions } from './types.ts'
import { resolveChatStreamConfig, type ResolvedChatStreamConfig } from './config.ts'

/**
 * Minimal interface for a Node.js-style readable stream body.
 * In Node.js, `fetch().body` may be a Node.js `Readable` rather than a Web
 * `ReadableStream`. We only need the `on()` method to bridge it.
 */
interface NodeReadableBody {
  on(event: 'data', cb: (chunk: Buffer) => void): void
  on(event: 'end', cb: () => void): void
  on(event: 'error', cb: (err: Error) => void): void
}

/**
 * Bridge a Node.js-style readable body to a Web ReadableStream.
 */
function toWebReadableStream(nodeBody: NodeReadableBody): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      nodeBody.on('data', (chunk: Buffer) => {
        controller.enqueue(new Uint8Array(chunk))
      })
      nodeBody.on('end', () => {
        controller.close()
      })
      nodeBody.on('error', (err: Error) => {
        controller.error(err)
      })
    }
  })
}

type OllamaTool = NonNullable<OllamaChatRequest['tools']>[number]

/**
 * Ollama chat provider implementation
 */
export const ollamaProvider: ChatProvider = {
  name: 'ollama',

  capabilities: {
    thinking: true,
    toolCalling: true,
  },

  stream(
    messages: OllamaMessage[],
    options?: ChatStreamOptions,
  ): Stream<ChatEvent, ChatResult> {
    return resource(function*(provide) {
      const signal = yield* useAbortSignal()
      const values: ResolvedChatStreamConfig = yield* resolveChatStreamConfig(options, {
        baseUri: process.env['OLLAMA_URL'] ?? 'http://localhost:11434',
        model: process.env['OLLAMA_MODEL'] ?? 'lfm2.5:latest',
        envApiKeyName: 'OLLAMA_API_KEY',
      })

      // Build tools array from schemas
      const toolSchemas = values.isomorphicToolSchemas ?? []

      const allTools: OllamaTool[] = toolSchemas.map(
        (schema) => ({
          type: 'function' as const,
          function: {
            name: schema.name,
            description: schema.description,
            parameters: schema.parameters,
          },
        })
      )

      const request: OllamaChatRequest = {
        model: values.model,
        messages,
        stream: true,
        ...(allTools.length > 0 && { tools: allTools }),
        ...(allTools.length > 0 && values.toolChoice && { tool_choice: values.toolChoice }),
        ...(values.schema && { format: values.schema }),
      }

      const url = `${values.baseUri.replace(/\/$/, '')}/api/chat`

      const response = yield* call(() =>
        fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(request),
          signal,
        })
      )

      if (!response.ok) {
        const errorText = yield* call(() => response.text())
        throw new Error(`Ollama API error: ${response.status} - ${errorText}`)
      }

      if (!response.body) {
        throw new Error('No response body')
      }

      // In Node.js, response.body might be a Node.js Readable, not a Web ReadableStream
      const readableStream = response.body instanceof ReadableStream
        ? response.body
        : toWebReadableStream(response.body as NodeReadableBody)

      const chunkStream = parseNDJSON<OllamaChatChunk>(readableStream)
      const subscription: Subscription<OllamaChatChunk, void> =
        yield* chunkStream

      // Accumulators
      let textBuffer = ''
      let thinkingBuffer = ''
      let toolCalls: ToolCall[] = []
      let usage: TokenUsage = {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
      }

      // Queue of events to yield
      const pendingEvents: ChatEvent[] = []

      yield* provide({
        *next(): Operation<IteratorResult<ChatEvent, ChatResult>> {
          // Yield any pending events first
          if (pendingEvents.length > 0) {
            return { done: false, value: pendingEvents.shift()! }
          }

          // Read next chunk from Ollama
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

          const chunk = next.value

          if (chunk.error) {
            throw new Error(`Ollama: ${chunk.error}`)
          }

          // Capture usage from final chunk
          if (chunk.done) {
            usage = {
              promptTokens: chunk.prompt_eval_count ?? 0,
              completionTokens: chunk.eval_count ?? 0,
              totalTokens:
                (chunk.prompt_eval_count ?? 0) + (chunk.eval_count ?? 0),
            }
          }

          // Accumulate and emit text
          if (chunk.message.content) {
            textBuffer += chunk.message.content
            pendingEvents.push({ type: 'text', content: chunk.message.content })
          }

          // Accumulate and emit thinking
          if (chunk.message.thinking) {
            thinkingBuffer += chunk.message.thinking
            pendingEvents.push({
              type: 'thinking',
              content: chunk.message.thinking,
            })
          }

          // Accumulate and emit tool calls
          if (chunk.message.tool_calls) {
            toolCalls = [...toolCalls, ...chunk.message.tool_calls]
            pendingEvents.push({
              type: 'tool_calls',
              toolCalls: chunk.message.tool_calls,
            })
          }

          // Return first pending event, or recurse to get next chunk
          if (pendingEvents.length > 0) {
            return { done: false, value: pendingEvents.shift()! }
          }

          // No events from this chunk, get next
          return yield* this.next()
        },
      })
    })
  },
}
