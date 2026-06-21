import { run, type Operation } from 'effection'

import type {
  ChatEvent,
  ChatResult,
  Message,
  ToolCall,
} from '@sweatpants/framework/chat'
import {
  createPiAiModelProviderDriver,
  resolveRuntimeModel,
  type AssistantMessage as ModelAssistantMessage,
  type Message as ModelMessage,
  type StreamEvent as ModelStreamEvent,
} from '@sweatpants/model-provider-pi-ai'

import { echoToolSchema } from './echo-tool.ts'

export interface LLMTurnResult {
  text: string
  toolCalls: ToolCall[]
  events: ChatEvent[]
  raw: ChatResult
}

export interface LLMTurnOptions {
  requireTool?: boolean
  allowTools?: boolean
}

export type ChatEventSink = (event: ChatEvent) => Operation<void>

function toModelMessage(message: Message): ModelMessage {
  if (message.role === 'system') return { role: 'system', content: message.content }
  if (message.role === 'user') return { role: 'user', content: message.content }
  if (message.role === 'assistant') {
    return {
      role: 'assistant',
      content: message.content ? [{ type: 'text' as const, text: message.content }] : [],
    }
  }
  return {
    role: 'toolResult',
    toolCallId: message.tool_call_id ?? '',
    toolName: message.replay?.toolName ?? '',
    content: [{ type: 'text' as const, text: message.content }],
    isError: message.content.startsWith('Error:'),
  }
}

function assistantText(message: ModelAssistantMessage): string {
  return message.content
    .filter((block): block is Extract<ModelAssistantMessage['content'][number], { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('')
}

function assistantToolCalls(message: ModelAssistantMessage): ToolCall[] {
  return message.content
    .filter((block): block is Extract<ModelAssistantMessage['content'][number], { type: 'toolCall' }> => block.type === 'toolCall')
    .map((block) => ({
      id: block.id,
      type: 'function' as const,
      function: {
        name: block.name,
        arguments: block.arguments,
      },
    }))
}

function usageFromAssistant(message: ModelAssistantMessage): ChatResult['usage'] {
  return {
    promptTokens: message.usage?.input ?? 0,
    completionTokens: message.usage?.output ?? 0,
    totalTokens: message.usage?.total ?? ((message.usage?.input ?? 0) + (message.usage?.output ?? 0)),
  }
}

function eventFromModelEvent(event: ModelStreamEvent): ChatEvent | null {
  if (event.type === 'text_delta') {
    return { type: 'text', content: event.delta }
  }
  if (event.type === 'thinking_delta') {
    return { type: 'thinking', content: event.delta }
  }
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

export function runLLMTurnOperation(
  messages: Message[],
  options: LLMTurnOptions = {},
  onEvent?: ChatEventSink,
): Operation<LLMTurnResult> {
  const { requireTool = false, allowTools = true } = options

  return {
    *[Symbol.iterator]() {
      const modelProvider = createPiAiModelProviderDriver()
      const model = resolveRuntimeModel('ollama', process.env['OLLAMA_MODEL'] ?? 'lfm2.5:latest')
      const stream = modelProvider.stream({
        model,
        context: {
          messages: messages.map(toModelMessage),
          ...(allowTools
            ? {
                tools: [{
                  name: echoToolSchema.name,
                  description: echoToolSchema.description,
                  parameters: echoToolSchema.parameters,
                }],
              }
            : {}),
        },
        options: {
          toolChoice: allowTools ? (requireTool ? 'required' : 'auto') : 'none',
        },
      })

      const subscription = yield* stream
      const events: ChatEvent[] = []
      const toolCalls: ToolCall[] = []

      while (true) {
        const next = yield* subscription.next()
        if (next.done) {
          const finalToolCalls = assistantToolCalls(next.value)
          const allToolCalls = finalToolCalls.length > 0 ? finalToolCalls : toolCalls
          const raw: ChatResult = {
            text: assistantText(next.value),
            ...(allToolCalls.length > 0 ? { toolCalls: allToolCalls } : {}),
            usage: usageFromAssistant(next.value),
          }
          return {
            text: raw.text,
            toolCalls: raw.toolCalls ?? [],
            events,
            raw,
          }
        }

        const event = eventFromModelEvent(next.value)
        if (!event) continue
        if (event.type === 'tool_calls') {
          toolCalls.push(...event.toolCalls)
        }
        if (onEvent) {
          yield* onEvent(event)
        }
        events.push(event)
      }
    },
  }
}

export async function runLLMTurn(
  messages: Message[],
  options: LLMTurnOptions = {},
): Promise<LLMTurnResult> {
  return run(function* () {
    return yield* runLLMTurnOperation(messages, options)
  })
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms)
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

export async function isOllamaAvailable(options: { requireToolCalling?: boolean } = {}): Promise<boolean> {
  const base = process.env['OLLAMA_URL'] ?? 'http://localhost:11434'
  const model = process.env['OLLAMA_MODEL'] ?? 'lfm2.5:latest'
  try {
    const response = await fetch(`${base}/api/tags`, {
      method: 'GET',
      signal: AbortSignal.timeout(1500),
    })
    if (!response.ok) {
      return false
    }
    const body = await response.json() as { models?: Array<{ name?: string; model?: string }> }
    const hasModel = (body.models ?? []).some((entry) => entry.name === model || entry.model === model)
    if (!hasModel || !options.requireToolCalling) {
      return hasModel
    }

    const toolProbe = await withTimeout(runLLMTurn([
      { id: 'system', role: 'system', content: 'When asked to echo, call the echo tool exactly once.' },
      { id: 'user', role: 'user', content: 'Use the echo tool with message "tool probe".' },
    ], { requireTool: true }), 5000)
    return toolProbe.toolCalls.some((call) => call.function.name === echoToolSchema.name)
  } catch {
    return false
  }
}
