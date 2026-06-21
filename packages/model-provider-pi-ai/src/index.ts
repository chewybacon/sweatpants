import { type Operation, type Subscription } from 'effection'
import type { AssistantMessage, Model, Runtime, StreamEvent, StreamOptions } from './runtime/index.ts'
import { createOllamaModel, createOpenAiResponsesModel, piAiRuntime } from './runtime/index.ts'
import {
  ModelProviderContext,
  ModelProviderModelContext,
  ModelProviderStreamOptionsContext,
  type ModelProviderDriver,
} from '@sweatpants/framework/chat'

export * from './runtime/index.ts'

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

export function createPiAiModelProviderDriver(runtime: Runtime = piAiRuntime): ModelProviderDriver {
  return {
    stream(request) {
      return runtime.stream(request.model, request.context, request.options)
    },
    *sample(request): Operation<AssistantMessage> {
      const subscription: Subscription<StreamEvent, AssistantMessage> = yield* runtime.stream(
        request.model,
        request.context,
        { ...request.options, toolChoice: request.options?.toolChoice ?? 'none' },
      )
      while (true) {
        const next = yield* subscription.next()
        if (next.done) return next.value
      }
    },
  }
}

export interface InstallPiAiModelProviderOptions {
  driver?: ModelProviderDriver
  model?: Model
  streamOptions?: StreamOptions
}

export function* installPiAiModelProvider(options: InstallPiAiModelProviderOptions = {}): Operation<void> {
  yield* ModelProviderContext.set(options.driver ?? createPiAiModelProviderDriver())
  if (options.model) {
    yield* ModelProviderModelContext.set(options.model)
  }
  if (options.streamOptions) {
    yield* ModelProviderStreamOptionsContext.set(options.streamOptions)
  }
}
