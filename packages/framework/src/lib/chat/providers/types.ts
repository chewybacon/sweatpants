import type { Stream } from 'effection'
import type { ChatEvent, ChatResult, OllamaMessage } from '../types'
import type { IsomorphicToolSchema } from '../isomorphic-tools'

/**
 * Provider capabilities - what features the provider supports
 */
export interface ProviderCapabilities {
  /** Whether provider can stream thinking/reasoning content */
  thinking: boolean
  /** Whether provider supports tool/function calling */
  toolCalling: boolean
}

/**
 * Options for streaming chat
 */
export interface ChatStreamOptions {
  apiUrl: string,
  model: string,
  /** Tool schemas to expose to the LLM */
  isomorphicToolSchemas?: IsomorphicToolSchema[]
}

/**
 * Chat provider interface - unified abstraction over different LLM backends
 */
export interface ChatProvider {
  /** Provider name for logging/debugging */
  readonly name: string

  /** Provider capabilities */
  readonly capabilities: ProviderCapabilities

  /**
   * Stream chat events from the provider.
   * Yields ChatEvent for each chunk, returns ChatResult with full response.
   */
  stream(
    messages: OllamaMessage[],
    options?: ChatStreamOptions
  ): Stream<ChatEvent, ChatResult>
}
