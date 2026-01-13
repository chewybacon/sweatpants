import type { Stream } from 'effection'
import type { Message } from '../types.ts'


import type { ChatEvent, ChatResult } from '../types.ts'
import type { IsomorphicToolSchema } from '../isomorphic-tools/index.ts'

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
  /** How the model should choose tools: 'auto' | 'none' | 'required' */
  toolChoice?: 'auto' | 'none' | 'required'
  /** JSON Schema for structured output */
  schema?: Record<string, unknown>
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
