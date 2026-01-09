/**
 * handler/types.ts
 *
 * Types for the server-side chat handler.
 * 
 * Shared types are imported from lib/chat.
 * Handler-specific types are defined here.
 */

import type { Operation } from 'effection'
import type { ZodType } from 'zod'

// =============================================================================
// RE-EXPORTS FROM lib/chat
// =============================================================================

// Core types
export type {
  Capabilities,
  TokenUsage,
  AuthorityMode,
} from '../lib/chat/core-types'

// Message types - re-export for convenience
export type { Message } from '../lib/chat/types'

// Tool context types
export type {
  ServerToolContext,
  ServerAuthorityContext,
} from '../lib/chat/isomorphic-tools/types'

// Provider types - re-export from canonical location
export type { ChatProvider } from '../lib/chat/providers/types'

// =============================================================================
// HANDLER-SPECIFIC TYPES
// =============================================================================

/**
 * Chat message alias (matches Message interface).
 */
export type ChatMessage = import('../lib/chat/types').Message

/**
 * A finalized isomorphic tool definition.
 * This is what the builder pattern produces.
 * 
 * NOTE: We use `any` types here intentionally. This interface needs to accept
 * tools from various builder patterns (FinalizedIsomorphicTool, etc.) which have
 * specific generic types. Using `unknown` breaks assignability.
 * 
 * TODO: This is a code smell. We should:
 * 1. Create a proper base interface that builder tools extend
 * 2. Use generics properly so type information flows through
 * 3. Avoid the need for `any` escape hatches
 * 
 * See: Type consolidation task - "deep dive into tools" for proper fix.
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
 * 
 * NOTE: Uses `any` for name/config/effort to accept various persona implementations.
 * TODO: Should use proper generics - see IsomorphicTool note above.
 */
export type PersonaResolver = (
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  name: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  config?: any,
  enableOptionalTools?: string[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  effort?: any
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
  | { type: 'text'; content: string }
  | { type: 'thinking'; content: string }
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
  // Plugin tool events
  | {
      type: 'plugin_elicit_request'
      sessionId: string
      callId: string
      toolName: string
      elicitId: string
      key: string
      message: string
      schema: Record<string, unknown>
    }
  | {
      type: 'plugin_session_error'
      sessionId: string
      callId: string
      error: 'SESSION_NOT_FOUND' | 'SESSION_ABORTED' | 'INTERNAL_ERROR'
      message: string
    }
  | {
      type: 'plugin_session_status'
      sessionId: string
      callId: string
      toolName: string
      status: 'running' | 'awaiting_elicit' | 'completed' | 'failed' | 'aborted'
    }
