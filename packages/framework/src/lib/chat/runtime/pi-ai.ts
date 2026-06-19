import { call, resource, useAbortSignal, type Operation } from 'effection'
import { generateImages as piGenerateImages, stream as piStream } from '@earendil-works/pi-ai'
import type {
  AssistantImages as PiAssistantImages,
  AssistantMessage as PiAssistantMessage,
  AssistantMessageEvent as PiAssistantMessageEvent,
  Context as PiContext,
  ImagesContext as PiImagesContext,
  ImagesModel as PiImagesModel,
  Model as PiModel,
  ProviderImagesOptions as PiProviderImagesOptions,
  ProviderStreamOptions as PiProviderStreamOptions,
  ToolCall as PiToolCall,
  Usage as PiUsage,
} from '@earendil-works/pi-ai'
import type {
  AssistantImages,
  AssistantMessage,
  ContentBlock,
  Context,
  ImageGenerationContext,
  ImageGenerationOptions,
  ImageModel,
  Model,
  Runtime,
  StreamEvent,
  StreamOptions,
  ToolCallBlock,
  Usage,
} from './types.ts'

interface CombinedAbortController {
  controller: AbortController
  cleanup(): void
}

function combineAbortSignals(scopeSignal: AbortSignal, callerSignal?: AbortSignal): CombinedAbortController {
  const controller = new AbortController()
  const abort = () => {
    if (!controller.signal.aborted) controller.abort()
  }

  scopeSignal.addEventListener('abort', abort, { once: true })
  callerSignal?.addEventListener('abort', abort, { once: true })

  if (scopeSignal.aborted || callerSignal?.aborted) abort()

  return {
    controller,
    cleanup() {
      scopeSignal.removeEventListener('abort', abort)
      callerSignal?.removeEventListener('abort', abort)
    },
  }
}

function toPiUsage(usage: Usage | undefined): PiUsage {
  return {
    input: usage?.input ?? 0,
    output: usage?.output ?? 0,
    cacheRead: usage?.cacheRead ?? 0,
    cacheWrite: usage?.cacheWrite ?? 0,
    totalTokens: usage?.total ?? (usage?.input ?? 0) + (usage?.output ?? 0),
    cost: {
      input: usage?.cost?.input ?? 0,
      output: usage?.cost?.output ?? 0,
      cacheRead: usage?.cost?.cacheRead ?? 0,
      cacheWrite: usage?.cost?.cacheWrite ?? 0,
      total: usage?.cost?.total ?? 0,
    },
  }
}

function fromPiUsage(usage: PiUsage | undefined): Usage | undefined {
  if (!usage) return undefined
  return {
    input: usage.input,
    output: usage.output,
    total: usage.totalTokens,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    cost: usage.cost,
  }
}

function toPiContentBlock(block: ContentBlock): unknown {
  switch (block.type) {
    case 'thinking':
      return {
        type: 'thinking',
        thinking: block.text,
      }
    default:
      return block
  }
}

function fromPiContentBlock(block: unknown): ContentBlock {
  const candidate = block as { type?: unknown; [key: string]: unknown }

  if (candidate.type === 'thinking') {
    return {
      type: 'thinking',
      text: typeof candidate['thinking'] === 'string' ? candidate['thinking'] : '',
      ...(typeof candidate['format'] === 'string' ? { format: candidate['format'] } : {}),
    }
  }

  if (candidate.type === 'text') {
    return { type: 'text', text: typeof candidate['text'] === 'string' ? candidate['text'] : '' }
  }

  if (candidate.type === 'image') {
    return {
      type: 'image',
      data: typeof candidate['data'] === 'string' ? candidate['data'] : '',
      mimeType: typeof candidate['mimeType'] === 'string' ? candidate['mimeType'] : 'application/octet-stream',
    }
  }

  if (candidate.type === 'toolCall') {
    return {
      type: 'toolCall',
      id: typeof candidate['id'] === 'string' ? candidate['id'] : '',
      name: typeof candidate['name'] === 'string' ? candidate['name'] : '',
      arguments: isRecord(candidate['arguments']) ? candidate['arguments'] : {},
    }
  }

  return { type: 'text', text: '' }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function fromPiToolCall(toolCall: PiToolCall): ToolCallBlock {
  return {
    type: 'toolCall',
    id: toolCall.id,
    name: toolCall.name,
    arguments: toolCall.arguments,
  }
}

function toPiAssistantMessage(message: AssistantMessage): PiAssistantMessage {
  return {
    role: 'assistant',
    content: message.content
      .filter((block) => block.type !== 'image')
      .map(toPiContentBlock) as PiAssistantMessage['content'],
    api: String(message.metadata?.['api'] ?? ''),
    provider: String(message.metadata?.['provider'] ?? ''),
    model: String(message.metadata?.['model'] ?? ''),
    ...(message.responseId ? { responseId: message.responseId } : {}),
    usage: toPiUsage(message.usage),
    stopReason: (message.stopReason ?? 'stop') as PiAssistantMessage['stopReason'],
    ...(message.errorMessage ? { errorMessage: message.errorMessage } : {}),
    timestamp: message.timestamp ?? Date.now(),
  }
}

function fromPiAssistantMessage(message: PiAssistantMessage): AssistantMessage {
  const usage = fromPiUsage(message.usage)
  return {
    role: 'assistant',
    content: message.content.map(fromPiContentBlock),
    ...(usage ? { usage } : {}),
    stopReason: message.stopReason,
    ...(message.responseId ? { responseId: message.responseId } : {}),
    ...(message.errorMessage ? { errorMessage: message.errorMessage } : {}),
    timestamp: message.timestamp,
    metadata: {
      api: message.api,
      provider: message.provider,
      model: message.model,
      ...(message.responseModel ? { responseModel: message.responseModel } : {}),
      ...(message.diagnostics ? { diagnostics: message.diagnostics } : {}),
    },
  }
}

function toPiContext(context: Context): PiContext {
  const messages: PiContext['messages'] = []

  for (const message of context.messages) {
    if (message.role === 'system') {
      messages.push({ role: 'user', content: message.content, timestamp: message.timestamp ?? Date.now() })
      continue
    }

    if (message.role === 'user') {
      messages.push({
        role: 'user',
        content: Array.isArray(message.content)
          ? message.content
              .filter((block) => block.type === 'text' || block.type === 'image')
              .map(toPiContentBlock) as Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>
          : message.content,
        timestamp: message.timestamp ?? Date.now(),
      })
      continue
    }

    if (message.role === 'assistant') {
      messages.push(toPiAssistantMessage(message))
      continue
    }

    messages.push({
      role: 'toolResult',
      toolCallId: message.toolCallId,
      toolName: message.toolName,
      content: message.content
        .filter((block) => block.type === 'text' || block.type === 'image')
        .map(toPiContentBlock) as Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>,
      isError: message.isError,
      timestamp: message.timestamp ?? Date.now(),
    })
  }

  const piContext: PiContext = {
    ...(context.systemPrompt ? { systemPrompt: context.systemPrompt } : {}),
    messages,
  }
  if (context.tools) piContext.tools = context.tools as NonNullable<PiContext['tools']>
  return piContext
}

function toPiModel(model: Model): PiModel<string> {
  return {
    id: model.id,
    name: model.name,
    api: model.api,
    provider: model.provider,
    baseUrl: model.baseUrl ?? '',
    reasoning: model.reasoning,
    input: model.input.filter((input): input is 'text' | 'image' => input === 'text' || input === 'image'),
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    cost: model.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ...(model.headers ? { headers: model.headers } : {}),
    ...(model.compat ? { compat: model.compat as never } : {}),
  }
}

function toPiImageModel(model: ImageModel): PiImagesModel<string> {
  return {
    id: model.id,
    name: model.name,
    api: model.api,
    provider: model.provider,
    baseUrl: model.baseUrl ?? '',
    input: model.input.filter((input): input is 'text' | 'image' => input === 'text' || input === 'image'),
    output: model.output.filter((output): output is 'text' | 'image' => output === 'text' || output === 'image'),
    cost: model.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ...(model.headers ? { headers: model.headers } : {}),
  }
}

function toPiStreamOptions(model: Model, options: StreamOptions | undefined, signal: AbortSignal): PiProviderStreamOptions {
  const apiKey = options?.apiKey ?? (model.provider === 'ollama' ? 'ollama' : undefined)
  return {
    ...(options?.providerOptions ?? {}),
    signal,
    ...(apiKey ? { apiKey } : {}),
    ...(options?.env ? { env: options.env as Record<string, string> } : {}),
    ...(options?.sessionId ? { sessionId: options.sessionId } : {}),
    ...(options?.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
    ...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(options?.onPayload ? { onPayload: (payload: unknown) => options.onPayload?.(payload) } : {}),
    ...(options?.reasoning && options.reasoning !== 'off' ? { reasoning: options.reasoning } : {}),
  }
}

function toPiImageOptions(options: ImageGenerationOptions | undefined, signal: AbortSignal): PiProviderImagesOptions {
  return {
    ...(options?.providerOptions ?? {}),
    signal,
    ...(options?.apiKey ? { apiKey: options.apiKey } : {}),
    ...(options?.headers ? { headers: options.headers } : {}),
    ...(options?.onPayload ? { onPayload: (payload: unknown) => options.onPayload?.(payload) } : {}),
    ...(options?.onResponse ? { onResponse: (response: unknown) => options.onResponse?.(response) } : {}),
  }
}

function fromPiEvent(event: PiAssistantMessageEvent): StreamEvent {
  switch (event.type) {
    case 'toolcall_end':
      return {
        type: 'toolcall_end',
        contentIndex: event.contentIndex,
        toolCall: fromPiToolCall(event.toolCall),
        partial: fromPiAssistantMessage(event.partial),
      }
    case 'done':
      return {
        type: 'done',
        reason: event.reason,
        message: fromPiAssistantMessage(event.message),
      }
    case 'error':
      return {
        type: 'error',
        reason: event.reason,
        error: fromPiAssistantMessage(event.error),
      }
    case 'text_end':
    case 'thinking_end':
      return {
        type: event.type,
        contentIndex: event.contentIndex,
        content: event.content,
        partial: fromPiAssistantMessage(event.partial),
      }
    case 'text_delta':
    case 'thinking_delta':
    case 'toolcall_delta':
      return {
        type: event.type,
        contentIndex: event.contentIndex,
        delta: event.delta,
        partial: fromPiAssistantMessage(event.partial),
      }
    case 'start':
      return {
        type: 'start',
        partial: fromPiAssistantMessage(event.partial),
      }
    default:
      return {
        type: event.type,
        contentIndex: event.contentIndex,
        partial: fromPiAssistantMessage(event.partial),
      }
  }
}

function toPiImagesContext(context: ImageGenerationContext): PiImagesContext {
  return {
    input: context.input.map(toPiContentBlock) as PiImagesContext['input'],
  }
}

function fromPiAssistantImages(images: PiAssistantImages): AssistantImages {
  const usage = fromPiUsage(images.usage)
  return {
    output: images.output.map(fromPiContentBlock) as AssistantImages['output'],
    ...(usage ? { usage } : {}),
    stopReason: images.stopReason,
    ...(images.responseId ? { responseId: images.responseId } : {}),
    ...(images.errorMessage ? { errorMessage: images.errorMessage } : {}),
    metadata: {
      api: images.api,
      provider: images.provider,
      model: images.model,
      timestamp: images.timestamp,
    },
  }
}

export function createPiAiRuntime(): Runtime {
  return {
    stream(model, context, options) {
      return resource(function* (provide) {
        const scopeSignal = yield* useAbortSignal()
        const combined = combineAbortSignals(scopeSignal, options?.signal)
        const stream = piStream(toPiModel(model), toPiContext(context), toPiStreamOptions(model, options, combined.controller.signal))
        const iterator = stream[Symbol.asyncIterator]()

        try {
          yield* provide({
            *next(): Operation<IteratorResult<StreamEvent, AssistantMessage>> {
              const next = yield* call(() => iterator.next())
              if (!next.done) {
                return { done: false, value: fromPiEvent(next.value) }
              }
              const finalMessage = yield* call(() => stream.result())
              return { done: true, value: fromPiAssistantMessage(finalMessage) }
            },
          })
        } finally {
          combined.controller.abort()
          combined.cleanup()
          if (typeof iterator.return === 'function') {
            yield* call(() => iterator.return!(undefined))
          }
        }
      })
    },

    generateImages(model, context, options) {
      return resource(function* (provide) {
        const scopeSignal = yield* useAbortSignal()
        const combined = combineAbortSignals(scopeSignal, options?.signal)
        try {
          const result = yield* call(() => piGenerateImages(
            toPiImageModel(model),
            toPiImagesContext(context),
            toPiImageOptions(options, combined.controller.signal),
          ))
          yield* provide(fromPiAssistantImages(result))
        } finally {
          combined.controller.abort()
          combined.cleanup()
        }
      })
    },
  }
}

export const piAiRuntime = createPiAiRuntime()

export function createOllamaModel(modelId: string, baseUrl = 'http://localhost:11434/v1'): Model {
  return {
    id: modelId,
    name: `${modelId} (Ollama)`,
    api: 'openai-completions',
    provider: 'ollama',
    baseUrl,
    reasoning: true,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 32000,
    compat: {
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      supportsStore: false,
      supportsStrictMode: false,
      supportsUsageInStreaming: false,
    },
  }
}

export function createOpenAiResponsesModel(modelId: string, baseUrl = 'https://api.openai.com/v1'): Model {
  return {
    id: modelId,
    name: modelId,
    api: 'openai-responses',
    provider: 'openai',
    baseUrl,
    reasoning: true,
    input: ['text', 'image'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 16384,
  }
}
