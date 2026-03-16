import { run } from 'effection'

import {
  ollamaProvider,
  type ChatEvent,
  type ChatResult,
  type Message,
  type ToolCall,
} from '@sweatpants/framework/chat'

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

export async function runLLMTurn(
  messages: Message[],
  options: LLMTurnOptions = {},
): Promise<LLMTurnResult> {
  const { requireTool = false, allowTools = true } = options

  return run(function* () {
    const stream = ollamaProvider.stream(messages, {
      model: process.env['OLLAMA_MODEL'] ?? 'glm-4.7-flash:latest',
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
      events.push(next.value)
    }
  })
}

export async function isOllamaAvailable(): Promise<boolean> {
  const base = process.env['OLLAMA_URL'] ?? 'http://localhost:11434'
  try {
    const response = await fetch(`${base}/api/tags`, { method: 'GET' })
    return response.ok
  } catch {
    return false
  }
}
