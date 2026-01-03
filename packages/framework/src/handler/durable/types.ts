/**
 * Types for Durable Chat Handler
 *
 * Defines types for the pull-based durable chat handler including:
 * - Engine state phases
 * - Engine parameters
 * - Durable stream events (with LSN)
 * - Handler configuration
 */
import type { Operation, Stream } from 'effection'
import type { ZodType } from 'zod'
import type { ChatProvider } from '../../lib/chat/providers/types'
import type { StreamEvent, ChatMessage } from '../types'

// =============================================================================
// ENGINE STATE PHASES
// =============================================================================

/**
 * Phases of the chat engine state machine.
 */
export type EnginePhase =
  | 'init'
  | 'process_client_outputs'
  | 'start_iteration'
  | 'streaming_provider'
  | 'provider_complete'
  | 'executing_tools'
  | 'tools_complete'
  | 'complete'
  | 'error'
  | 'handoff_pending'
  | 'done'

// =============================================================================
// TOOL TYPES
// =============================================================================

/**
 * Tool call from the LLM.
 */
export interface ToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: unknown
  }
}

/**
 * Schema for a tool exposed to the LLM.
 */
export interface ToolSchema {
  name: string
  description: string
  parameters: Record<string, unknown>
  isIsomorphic?: boolean
  authority?: 'server' | 'client'
}

/**
 * An isomorphic tool definition.
 */
export interface IsomorphicTool {
  name: string
  description: string
  parameters: ZodType<unknown>
  authority?: 'server' | 'client'
  server?: (params: unknown, ctx: unknown) => Operation<unknown>
  client?: (input: unknown, ctx: unknown, params: unknown) => Operation<unknown>
}

/**
 * Tool registry interface.
 */
export interface ToolRegistry {
  get(name: string): IsomorphicTool | undefined
  has(name: string): boolean
  names(): string[]
}

/**
 * Result of tool execution.
 */
export type ToolExecutionResult =
  | {
      ok: true
      kind: 'result'
      callId: string
      toolName: string
      serverOutput: unknown
    }
  | {
      ok: true
      kind: 'handoff'
      callId: string
      toolName: string
      handoff: StreamEvent & { type: 'isomorphic_handoff' }
      serverOutput?: unknown
    }
  | {
      ok: false
      error: {
        callId: string
        toolName: string
        message: string
      }
    }

// =============================================================================
// CLIENT OUTPUT TYPES
// =============================================================================

/**
 * Client output for isomorphic tool phase 2.
 */
export interface IsomorphicClientOutput {
  callId: string
  toolName: string
  params: unknown
  clientOutput: unknown
  cachedHandoff?: unknown
  usesHandoff?: boolean
}

// =============================================================================
// ENGINE PARAMS
// =============================================================================

/**
 * Parameters for creating a chat engine.
 */
export interface ChatEngineParams {
  /** Conversation messages */
  messages: ChatMessage[]

  /** System prompt to prepend */
  systemPrompt?: string

  /** Tool schemas to expose to LLM */
  toolSchemas: ToolSchema[]

  /** Tool registry for server-side execution */
  toolRegistry: ToolRegistry

  /** Client-provided isomorphic tool schemas */
  clientIsomorphicTools: ToolSchema[]

  /** Client outputs from phase 1 handoffs */
  isomorphicClientOutputs: IsomorphicClientOutput[]

  /** Chat provider for LLM calls */
  provider: ChatProvider

  /** Maximum tool loop iterations */
  maxIterations: number

  /** Abort signal for cancellation */
  signal: AbortSignal

  /** Optional model override */
  model?: string

  /** Session info to emit at start */
  sessionInfo?: StreamEvent & { type: 'session_info' }
}

// =============================================================================
// DURABLE STREAM TYPES
// =============================================================================

/**
 * A stream event with LSN for durable streaming.
 * This is what gets serialized to the buffer and sent to clients.
 */
export interface DurableStreamEvent {
  /** Log Sequence Number - position in the stream */
  lsn: number
  /** The actual event payload */
  event: StreamEvent
}

// =============================================================================
// HANDLER CONFIG
// =============================================================================

/**
 * Initializer hook context.
 */
export interface InitializerContext {
  request: Request
  body: ChatRequestBody
}

/**
 * Initializer hook type.
 */
export type InitializerHook = (ctx: InitializerContext) => Operation<void>

/**
 * Request body for chat requests.
 */
export interface ChatRequestBody {
  messages: ChatMessage[]
  systemPrompt?: string
  persona?: string
  personaConfig?: unknown
  enableOptionalTools?: string[]
  effort?: string
  enabledTools?: boolean | string[]
  isomorphicTools?: ToolSchema[]
  isomorphicClientOutputs?: IsomorphicClientOutput[]
  model?: string
}

/**
 * Configuration for the durable chat handler.
 */
export interface DurableChatHandlerConfig {
  /** Hooks to run during initialization (set up DI contexts) */
  initializerHooks: InitializerHook[]

  /** Maximum tool loop iterations (default: 10) */
  maxToolIterations?: number
}

// =============================================================================
// PROTOCOL PARAMS
// =============================================================================

/**
 * Protocol parameters extracted from request headers/query.
 */
export interface DurableStreamParams {
  /** Session ID for reconnection */
  sessionId?: string

  /** Last LSN received - resume from this point */
  lastLSN?: number
}

// =============================================================================
// CHAT ENGINE TYPE
// =============================================================================

/**
 * The chat engine - a pull-based stream of events.
 */
export type ChatEngine = Stream<StreamEvent, void>
