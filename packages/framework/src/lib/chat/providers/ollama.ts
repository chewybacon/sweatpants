import type { Operation, Stream, Subscription } from 'effection'
import { resource, call, useAbortSignal } from 'effection'
import { parseNDJSON } from '../ndjson'
import type {
  OllamaMessage,
  OllamaChatRequest,
  OllamaChatChunk,
  ChatEvent,
  ChatResult,
  TokenUsage,
  ToolCall,
} from '../types'
import type { ChatProvider, ChatStreamOptions } from './types'
import { resolveChatStreamConfig } from './config'

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
      const values = yield* resolveChatStreamConfig(options, {
        baseUri: process.env['OLLAMA_URL'] ?? 'http://localhost:11434',
        model: process.env['OLLAMA_MODEL'] ?? 'qwen3:30b',
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
