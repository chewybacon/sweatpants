import { run, type Operation } from 'effection'

import type {
  ChatEvent,
  ChatResult,
  Message,
  ToolCall,
} from '@sweatpants/framework/chat'
import { ollamaProvider } from '@sweatpants/framework/chat/providers'

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

export function runLLMTurnOperation(
  messages: Message[],
  options: LLMTurnOptions = {},
  onEvent?: ChatEventSink,
): Operation<LLMTurnResult> {
  const { requireTool = false, allowTools = true } = options

  return {
    *[Symbol.iterator]() {
      const stream = ollamaProvider.stream(messages, {
        model: process.env['OLLAMA_MODEL'] ?? 'lfm2.5:latest',
        ...(allowTools
          ? {
              isomorphicToolSchemas: [echoToolSchema],
              toolChoice: requireTool ? 'required' : 'auto',
            }
          : {
              toolChoice: 'none',
            }),
      })

      const subscription = yield* stream
      const events: ChatEvent[] = []

      while (true) {
        const next = yield* subscription.next()
        if (next.done) {
          return {
            text: next.value.text,
            toolCalls: next.value.toolCalls ?? [],
            events,
            raw: next.value,
          }
        }
        if (onEvent) {
          yield* onEvent(next.value)
        }
        events.push(next.value)
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

export async function isOllamaAvailable(options: { requireToolCalling?: boolean } = {}): Promise<boolean> {
  const base = process.env['OLLAMA_URL'] ?? 'http://localhost:11434'
  const model = process.env['OLLAMA_MODEL'] ?? 'lfm2.5:latest'
  try {
    const response = await fetch(`${base}/api/tags`, { method: 'GET' })
    if (!response.ok) {
      return false
    }
    const body = await response.json() as { models?: Array<{ name?: string; model?: string }> }
    const hasModel = (body.models ?? []).some((entry) => entry.name === model || entry.model === model)
    if (!hasModel || !options.requireToolCalling) {
      return hasModel
    }

    const toolProbe = await runLLMTurn([
      { id: 'system', role: 'system', content: 'When asked to echo, call the echo tool exactly once.' },
      { id: 'user', role: 'user', content: 'Use the echo tool with message "tool probe".' },
    ], { requireTool: true })
    return toolProbe.toolCalls.some((call) => call.function.name === 'echo')
  } catch {
    return false
  }
}
