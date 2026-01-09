/**
 * Types for Durable Chat Handler
 *
 * Defines types for the pull-based durable chat handler including:
 * - Engine state phases
 * - Engine parameters
 * - Durable stream events (with LSN)
 * - Handler configuration
 */
import type { Operation, Stream, Channel } from 'effection'
import type { ZodType } from 'zod'
import type { ChatProvider } from '../../lib/chat/providers/types'
import type { StreamEvent, ChatMessage } from '../types'
import type { PluginRegistry } from '../../lib/chat/mcp-tools/plugin-registry'
import type { ComponentEmissionPayload, PendingEmission } from '../../lib/chat/isomorphic-tools/runtime/emissions'
import type { PluginSessionManager } from './plugin-session-manager'

// =============================================================================
// ENGINE STATE PHASES
// =============================================================================

/**
 * Phases of the chat engine state machine.
 */
export type EnginePhase =
  | 'init'
  | 'process_plugin_abort'      // Handle explicit abort requests
  | 'process_plugin_responses'  // Resume suspended plugin sessions
  | 'process_client_outputs'
  | 'start_iteration'
  | 'streaming_provider'
  | 'provider_complete'
  | 'executing_tools'
  | 'tools_complete'
  | 'plugin_awaiting_elicit'    // Plugin tool waiting for elicitation
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
 * MCP tool registry interface.
 * Used for looking up MCP tool definitions (with .elicits) for plugin execution.
 */
export interface McpToolRegistry {
  get(name: string): unknown | undefined
  has(name: string): boolean
  names(): string[]
}

/**
 * Plugin elicitation request event data.
 */
export interface PluginElicitRequestData {
  sessionId: string
  callId: string
  toolName: string
  elicitId: string
  key: string
  message: string
  schema: Record<string, unknown>
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
      ok: true
      kind: 'plugin_awaiting'
      callId: string
      toolName: string
      sessionId: string
      elicitRequest: PluginElicitRequestData
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

  /**
   * Plugin registry for MCP plugin tools.
   * When a tool call matches a registered plugin, the chat engine will:
   * 1. Run the tool via BridgeHost
   * 2. Handle elicit events by dispatching to plugin handlers
   * 3. Handle sample events using the chat provider
   */
  pluginRegistry?: PluginRegistry

  /**
   * Emission channel for plugin elicitation UI.
   * When a plugin handler calls ctx.render(), the emission is sent through this channel.
   * The React layer subscribes to this channel to render components.
   */
  pluginEmissionChannel?: Channel<PendingEmission<ComponentEmissionPayload, unknown>, void>

  /**
   * MCP tool registry for looking up MCP tool definitions.
   * When a tool call matches a registered plugin, we need the tool definition
   * to create a BridgeHost for execution.
   */
  mcpToolRegistry?: McpToolRegistry

  /**
   * Plugin session manager for creating/resuming plugin tool sessions.
   * Sessions persist across HTTP request boundaries, allowing tools to
   * suspend for elicitation and resume when the user responds.
   */
  pluginSessionManager?: PluginSessionManager

  /**
   * Responses to pending plugin elicitation requests.
   * When resuming a session, these are processed first.
   */
  pluginElicitResponses?: PluginElicitResponse[]

  /**
   * Request to abort a specific plugin session.
   */
  pluginAbort?: PluginAbortRequest
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
 * Response to a plugin elicitation request.
 * Sent by the client when user completes an elicitation UI.
 */
export interface PluginElicitResponse {
  /** Session ID (same as callId from the original tool call) */
  sessionId: string

  /** Original tool call ID for conversation correlation */
  callId: string

  /** Specific elicit request ID */
  elicitId: string

  /** The user's response */
  result: {
    action: 'accept' | 'decline' | 'cancel'
    content?: unknown
  }
}

/**
 * Request to abort a plugin session.
 */
export interface PluginAbortRequest {
  /** Session ID to abort */
  sessionId: string

  /** Optional abort reason */
  reason?: string
}

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
  provider?: 'ollama' | 'openai'

  /**
   * Responses to pending plugin elicitation requests.
   * When a plugin tool emits plugin_elicit_request, the client renders UI,
   * collects the user's response, and sends it back here.
   */
  pluginElicitResponses?: PluginElicitResponse[]

  /**
   * Request to abort a specific plugin session.
   * Used when the user cancels an in-progress plugin tool.
   */
  pluginAbort?: PluginAbortRequest
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
