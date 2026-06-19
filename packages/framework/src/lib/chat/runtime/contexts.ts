import { createContext } from 'effection'
import type { Model, Runtime, StreamOptions } from './types.ts'
import { createOllamaModel, createOpenAiResponsesModel, piAiRuntime } from './pi-ai.ts'

export const RuntimeStreamConfigContext = createContext<StreamOptions>('RuntimeStreamOptions')
export const RuntimeModelContext = createContext<Model>('RuntimeModel')
export const RuntimeContext = createContext<Runtime>('Runtime')

function normalizeOllamaBaseUrl(value: string): string {
  const trimmed = value.replace(/\/$/, '')
  return trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`
}

export function resolveRuntimeModel(provider: 'ollama' | 'openai' | string = process.env['CHAT_PROVIDER'] ?? 'ollama', modelOverride?: string): Model {
  if (provider === 'openai') {
    return createOpenAiResponsesModel(
      modelOverride ?? process.env['OPENAI_MODEL'] ?? 'gpt-5-chat-latest',
      process.env['OPENAI_BASE_URL'] ?? 'https://api.openai.com/v1',
    )
  }

  return createOllamaModel(
    modelOverride ?? process.env['OLLAMA_MODEL'] ?? 'lfm2.5:latest',
    normalizeOllamaBaseUrl(process.env['OLLAMA_BASE_URL'] ?? process.env['OLLAMA_URL'] ?? 'http://localhost:11434'),
  )
}

export const DefaultRuntime = piAiRuntime
