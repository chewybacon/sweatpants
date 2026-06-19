import { resource, type Operation, type Subscription } from 'effection'
import type { ChatEvent, ChatResult, Message, TokenUsage, ToolCall } from '../types.ts'
import { createOllamaModel, piAiRuntime, type AssistantMessage, type Context, type StreamEvent } from '../runtime/index.ts'
import type { ChatProvider, ChatStreamOptions } from './types.ts'

function toRuntimeContext(messages: Message[], options?: ChatStreamOptions): Context {
  const runtimeMessages: Context['messages'] = []
  let systemPrompt: string | undefined

  for (const message of messages) {
    if (message.role === 'system') {
      systemPrompt = systemPrompt ? `${systemPrompt}\n\n${message.content}` : message.content
      continue
    }

    if (message.role === 'user') {
      runtimeMessages.push({ role: 'user', content: message.content })
      continue
    }

    if (message.role === 'tool') {
      runtimeMessages.push({
        role: 'toolResult',
        toolCallId: message.tool_call_id ?? '',
        toolName: message.replay?.toolName ?? '',
        content: [{ type: 'text', text: message.content }],
        isError: message.content.startsWith('Error:'),
      })
      continue
    }

    runtimeMessages.push({
      role: 'assistant',
      content: [
        ...(message.content ? [{ type: 'text' as const, text: message.content }] : []),
        ...(message.tool_calls ?? []).map((toolCall) => ({
          type: 'toolCall' as const,
          id: toolCall.id,
          name: toolCall.function.name,
          arguments: toolCall.function.arguments,
        })),
      ],
    })
  }

  return {
    ...(systemPrompt ? { systemPrompt } : {}),
    messages: runtimeMessages,
    ...(options?.isomorphicToolSchemas
      ? {
          tools: options.isomorphicToolSchemas.map((schema) => ({
            name: schema.name,
            description: schema.description,
            parameters: schema.parameters,
          })),
        }
      : {}),
  }
}

function toTokenUsage(message: AssistantMessage): TokenUsage {
  return {
    promptTokens: message.usage?.input ?? 0,
    completionTokens: message.usage?.output ?? 0,
    totalTokens: message.usage?.total ?? (message.usage?.input ?? 0) + (message.usage?.output ?? 0),
  }
}

function assertSuccessfulAssistant(message: AssistantMessage): void {
  if (message.stopReason === 'error' || message.stopReason === 'aborted') {
    throw new Error(message.errorMessage ?? `Provider generation ${message.stopReason}`)
  }
}

function toChatResult(message: AssistantMessage): ChatResult {
  assertSuccessfulAssistant(message)
  const toolCalls: ToolCall[] = []
  let text = ''
  let thinking = ''

  for (const block of message.content) {
    if (block.type === 'text') text += block.text
    if (block.type === 'thinking') thinking += block.text
    if (block.type === 'toolCall') {
      toolCalls.push({
        id: block.id,
        type: 'function',
        function: {
          name: block.name,
          arguments: block.arguments,
        },
      })
    }
  }

  return {
    text,
    ...(thinking ? { thinking } : {}),
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
    usage: toTokenUsage(message),
  }
}

function toChatEvent(event: StreamEvent): ChatEvent | null {
  if (event.type === 'error') {
    throw new Error(event.error.errorMessage ?? `Provider generation ${event.reason}`)
  }
  if (event.type === 'text_delta') return { type: 'text', content: event.delta }
  if (event.type === 'thinking_delta') return { type: 'thinking', content: event.delta }
  if (event.type === 'toolcall_end') {
    return {
      type: 'tool_calls',
      toolCalls: [{
        id: event.toolCall.id,
        type: 'function',
        function: {
          name: event.toolCall.name,
          arguments: event.toolCall.arguments,
        },
      }],
    }
  }
  return null
}

function normalizeOllamaBaseUrl(value: string): string {
  const trimmed = value.replace(/\/$/, '')
  return trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`
}

function createRuntimeBackedProvider(name: string, defaultModel: () => ReturnType<typeof createOllamaModel>): ChatProvider {
  return {
    name,
    capabilities: { thinking: true, toolCalling: true },
    stream(messages, options) {
      return resource(function* (provide) {
        const model = defaultModel()
        const subscription: Subscription<StreamEvent, AssistantMessage> = yield* piAiRuntime.stream(
          {
            ...model,
            ...(options?.model ? { id: options.model, name: `${options.model} (Ollama)` } : {}),
            ...(options?.baseUri ? { baseUrl: normalizeOllamaBaseUrl(options.baseUri) } : {}),
          },
          toRuntimeContext(messages, options),
          {
            ...(options?.apiKey ? { apiKey: options.apiKey } : {}),
            ...(options?.toolChoice ? { toolChoice: options.toolChoice } : {}),
            ...(options?.schema ? { responseFormat: { type: 'json_schema', name: 'structured_output', schema: options.schema } } : {}),
          },
        )

        yield* provide({
          *next(): Operation<IteratorResult<ChatEvent, ChatResult>> {
            while (true) {
              const next = yield* subscription.next()
              if (next.done) return { done: true, value: toChatResult(next.value) }
              const event = toChatEvent(next.value)
              if (event) return { done: false, value: event }
            }
          },
        })
      })
    },
  }
}

export const ollamaProvider: ChatProvider = createRuntimeBackedProvider('ollama', () =>
  createOllamaModel(
    process.env['OLLAMA_MODEL'] ?? 'lfm2.5:latest',
    normalizeOllamaBaseUrl(process.env['OLLAMA_BASE_URL'] ?? process.env['OLLAMA_URL'] ?? 'http://localhost:11434'),
  ),
)
