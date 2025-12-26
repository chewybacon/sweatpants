/**
 * Chat Handler Types
 *
 * These types define the contract between the framework's chat handler
 * and the user-provided implementations.
 */
import type { Operation } from 'effection'
import type { ZodType } from 'zod'

// =============================================================================
// MESSAGE TYPES
// =============================================================================

// Message interface is defined in lib/chat (core dependency)
import type { Message } from '../lib/chat/types'
export type { Message } from '../lib/chat/types'

// =============================================================================
// TOOL TYPES
// =============================================================================

/**
 * Server tool execution context.
 */
export interface ServerToolContext {
  callId: string
  signal: AbortSignal
}

/**
 * Server authority context with handoff capability.
 */
export interface ServerAuthorityContext extends ServerToolContext {
  handoff<THandoff, TResult>(config: {
    before: () => Operation<THandoff>
    after: (handoff: THandoff, clientOutput: unknown) => Operation<TResult>
  }): Operation<TResult>
}

/**
 * A finalized isomorphic tool definition.
 * This is what the builder pattern produces.
 * 
 * We use a loose interface here to accept tools from various builder patterns.
 */
export interface IsomorphicTool {
  name: string
  description: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  parameters: ZodType<any>
  authority?: 'server' | 'client'
  approval?: {
    client?: 'none' | 'confirm' | 'permission'
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    clientMessage?: string | ((params: any) => string)
  }
  handoffConfig?: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    before: (params: any, ctx: any) => Operation<any>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    client: (handoff: any, ctx: any, params: any) => Operation<any>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    after: (handoff: any, client: any, ctx: any, params: any) => Operation<any>
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  server?: (params: any, ctx: any, clientOutput?: any) => Operation<any>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client?: (input: any, ctx: any, params: any) => Operation<any>
}
export interface ServerAuthorityContext extends ServerToolContext {
  handoff<THandoff, TResult>(config: {
    before: () => Operation<THandoff>
    after: (handoff: THandoff, clientOutput: unknown) => Operation<TResult>
  }): Operation<TResult>
}

// =============================================================================
// PROVIDER TYPES
// =============================================================================

// ChatMessage is now an alias for the universal Message interface
export type ChatMessage = Message

/**
 * Streaming event from chat provider.
 */
export type ChatProviderEvent =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_calls'; toolCalls: Array<{
      id: string
      type: 'function'
      function: {
        name: string
        arguments: Record<string, unknown>
      }
    }> }

/**
 * Final result from chat provider stream.
 */
export interface ChatProviderResult {
  text: string
  toolCalls?: Array<{
    id: string
    type: 'function'
    function: {
      name: string
      arguments: Record<string, unknown>
    }
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
  }
}

/**
 * Tool schema for LLM.
 */
export interface ToolSchema {
  name: string
  description: string
  parameters: Record<string, unknown>
  isIsomorphic?: boolean
  authority?: 'server' | 'client'
}

/**
 * Options for provider stream.
 */
export interface ChatStreamOptions {
  isomorphicToolSchemas?: ToolSchema[]
}

/**
 * Chat provider interface.
 * 
 * The stream method should return something that can be async iterated
 * and has a result promise. This is compatible with effection Streams.
 */
export interface ChatProvider {
  name?: string
  stream(
    messages: Message[],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    options?: any
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): any // Accept any stream-like return type
}

// =============================================================================
// PERSONA TYPES
// =============================================================================

/**
 * Resolved persona with all values computed.
 */
export interface ResolvedPersona {
  name: string
  systemPrompt: string
  tools: string[]
  model?: Record<string, string>
  capabilities: {
    thinking: boolean
    streaming: boolean
    tools: string[]
  }
}

/**
 * Persona resolver function.
 */
export type PersonaResolver = (
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  name: any, // Accept any name format
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  config?: any, // Accept any config format
  enableOptionalTools?: string[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  effort?: any // Accept any effort format
) => ResolvedPersona

// =============================================================================
// STREAM EVENT TYPES
// =============================================================================

/**
 * Events emitted by the chat handler stream.
 */
export type StreamEvent =
  | {
      type: 'session_info'
      capabilities: {
        thinking: boolean
        streaming: boolean
        tools: string[]
      }
      persona: string | null
    }
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | {
      type: 'tool_calls'
      calls: Array<{
        id: string
        name: string
        arguments: unknown
      }>
    }
  | {
      type: 'tool_result'
      id: string
      name: string
      content: string
    }
  | {
      type: 'tool_error'
      id: string
      name: string
      message: string
    }
  | {
      type: 'isomorphic_handoff'
      callId: string
      toolName: string
      params: unknown
      serverOutput: unknown
      authority: 'server' | 'client'
      usesHandoff: boolean
    }
  | {
      type: 'conversation_state'
      conversationState: {
        messages: ChatMessage[]
        assistantContent: string
        toolCalls: Array<{
          id: string
          name: string
          arguments: unknown
        }>
        serverToolResults: Array<{
          id: string
          name: string
          content: string
          isError: boolean
        }>
      }
    }
  | {
      type: 'complete'
      text: string
      usage?: {
        prompt_tokens?: number
        completion_tokens?: number
        total_tokens?: number
      }
    }
  | {
      type: 'error'
      message: string
      recoverable: boolean
    }

// =============================================================================
// HANDLER CONFIG
// =============================================================================

/**
 * Configuration for createChatHandler.
 */
export interface ChatHandlerConfig {
  /**
   * Array of isomorphic tool definitions.
   */
  tools: IsomorphicTool[]

  /**
   * Chat provider instance or getter function.
   */
  provider: ChatProvider | (() => ChatProvider)

  /**
   * Optional persona resolver.
   * If not provided, persona mode is disabled.
   */
  resolvePersona?: PersonaResolver

  /**
   * Maximum number of tool execution iterations.
   * @default 10
   */
  maxToolIterations?: number
}

/**
 * Request body for the chat endpoint.
 */
export interface ChatRequestBody {
  messages: ChatMessage[]
  enabledTools?: string[] | boolean
  isomorphicTools?: ToolSchema[]
  isomorphicClientOutputs?: Array<{
    callId: string
    toolName: string
    params: unknown
    clientOutput: unknown
    cachedHandoff?: unknown
    usesHandoff?: boolean
  }>
  systemPrompt?: string
  persona?: string
  personaConfig?: Record<string, unknown>
  enableOptionalTools?: string[]
  effort?: 'auto' | 'low' | 'medium' | 'high'
}
