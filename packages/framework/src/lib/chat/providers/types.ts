import type { Stream } from 'effection'
import type { Message } from '../types'


import type { ChatEvent, ChatResult } from '../types'
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
  /** Provider base URI (e.g., http://localhost:11434 or https://api.openai.com/v1) */
  baseUri?: string
  /** Model identifier for the provider */
  model?: string
  /** Optional API key when required by provider */
  apiKey?: string | null
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
    messages: Message[],
    options?: ChatStreamOptions
  ): Stream<ChatEvent, ChatResult>
}
