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
} from '../lib/chat/core-types.ts'

// Message types - re-export for convenience
export type { Message } from '../lib/chat/types.ts'
import type { Message as ChatMessageBase } from '../lib/chat/types.ts'

// Tool context types
export type {
  ServerToolContext,
  ServerAuthorityContext,
} from '../lib/chat/isomorphic-tools/types.ts'

// Provider types - re-export from canonical location
export type { ChatProvider } from '../lib/chat/providers/types.ts'

// =============================================================================
// HANDLER-SPECIFIC TYPES
// =============================================================================

export type ChatMessage = ChatMessageBase

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

// Streaming types - re-export from session layer (single source of truth)
export type {
  StreamEvent,
  ConversationState,
  ConversationStateStreamEvent,
  IsomorphicHandoffStreamEvent,
  ElicitRequestStreamEvent,
  ToolSessionStatusStreamEvent,
  ToolSessionErrorStreamEvent,
} from '../lib/chat/session/streaming.ts'
