import { resource, type Operation, type Subscription } from 'effection'
import type { ChatEvent, ChatResult, Message, TokenUsage, ToolCall } from '../types.ts'
import { createOpenAiResponsesModel, piAiRuntime, type AssistantMessage, type Context, type StreamEvent } from '../runtime/index.ts'
import type { ChatProvider, ChatStreamOptions } from './types.ts'

function toRuntimeContext(messages: Message[], options?: ChatStreamOptions): Context {
  const runtimeMessages: Context['messages'] = []
  let systemPrompt: string | undefined

  for (const message of messages) {
    if (message.role === 'system') {
      systemPrompt = systemPrompt ? `${systemPrompt}\n\n${message.content}` : message.content
    } else if (message.role === 'user') {
      runtimeMessages.push({ role: 'user', content: message.content })
    } else if (message.role === 'tool') {
      runtimeMessages.push({
        role: 'toolResult',
        toolCallId: message.tool_call_id ?? '',
        toolName: message.replay?.toolName ?? '',
        content: [{ type: 'text', text: message.content }],
        isError: message.content.startsWith('Error:'),
      })
    } else {
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
        function: { name: block.name, arguments: block.arguments },
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
        function: { name: event.toolCall.name, arguments: event.toolCall.arguments },
      }],
    }
  }
  return null
}

/**
 * OpenAI provider compatibility export backed by the Sweatpants Runtime.
 * Production model execution no longer owns OpenAI SSE parsing here.
 */
export const openaiProvider: ChatProvider = {
  name: 'openai',
  capabilities: { thinking: true, toolCalling: true },
  stream(messages: Message[], options?: ChatStreamOptions) {
    return resource(function* (provide) {
      const subscription: Subscription<StreamEvent, AssistantMessage> = yield* piAiRuntime.stream(
        createOpenAiResponsesModel(
          options?.model ?? process.env['OPENAI_MODEL'] ?? 'gpt-5-chat-latest',
          options?.baseUri ?? process.env['OPENAI_BASE_URL'] ?? 'https://api.openai.com/v1',
        ),
        toRuntimeContext(messages, options),
        {
          apiKey: options?.apiKey ?? process.env['OPENAI_API_KEY'] ?? null,
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

interface OpenAIInputMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
}

interface OpenAIFunctionCallItem {
  type: 'function_call'
  call_id: string
  name: string
  arguments: string
}

interface OpenAIFunctionCallOutputItem {
  type: 'function_call_output'
  call_id: string
  output: string
}

type OpenAIInputItem = OpenAIInputMessage | OpenAIFunctionCallItem | OpenAIFunctionCallOutputItem

export function toOpenAIInput(messages: Message[]): OpenAIInputItem[] {
  const items: OpenAIInputItem[] = []

  for (const message of messages) {
    if (message.role === 'system' || message.role === 'user') {
      items.push({ role: message.role, content: message.content })
      continue
    }

    if (message.role === 'assistant') {
      if (message.content) {
        items.push({ role: 'assistant', content: message.content })
      }

      for (const toolCall of message.tool_calls ?? []) {
        items.push({
          type: 'function_call',
          call_id: toolCall.id,
          name: toolCall.function.name,
          arguments: JSON.stringify(toolCall.function.arguments),
        })
      }
      continue
    }

    if (message.role === 'tool' && message.tool_call_id) {
      items.push({
        type: 'function_call_output',
        call_id: message.tool_call_id,
        output: message.content,
      })
    }
  }

  return items
}
