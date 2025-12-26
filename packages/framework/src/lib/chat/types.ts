
// --- Message Types ---

/**
 * Universal message interface that all chat providers must support.
 * This provides a common contract for message passing between layers.
 */
export interface Message {
  id?: string
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  partial?: boolean
  tool_calls?: Array<{
    id: string
    type: 'function'
    function: {
      name: string
      arguments: Record<string, unknown>
    }
  }>
  tool_call_id?: string
}

/**
 * Ollama-specific message format (alias for Message for backward compatibility).
 */
export type OllamaMessage = Message

export interface ToolCall {
  id: string
  function: {
    name: string
    arguments: Record<string, unknown>
  }
}

// --- Provider Event Types ---

export type ChatEvent =
  | { type: 'text'; content: string }
  | { type: 'thinking'; content: string }
  | { type: 'tool_calls'; toolCalls: ToolCall[] }

export interface ChatResult {
  text: string
  thinking?: string
  toolCalls?: ToolCall[]
  usage: TokenUsage
}

export interface TokenUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

// --- Stream Event Types (Server -> Client) ---

export type StreamEvent =
  | { type: 'session_info'; capabilities: any; persona: string | null } // Using any to avoid circular dep
  | { type: 'text'; content: string }
  | { type: 'thinking'; content: string }
  | { type: 'tool_calls'; calls: ToolCallInfo[] }
  | { type: 'tool_result'; id: string; name: string; content: string }
  | { type: 'tool_error'; id: string; name: string; message: string }
  | { type: 'complete'; text: string; usage?: TokenUsage }
  | { type: 'error'; message: string; recoverable: boolean }
  | IsomorphicHandoffEvent
  | ConversationStateEvent

/**
 * Event emitted to provide full conversation state for client-side processing.
 * Used when isomorphic tools need handoff to client.
 */
export interface ConversationStateEvent {
  type: 'conversation_state'
  conversationState: ConversationState
}

/**
 * Event emitted when an isomorphic tool's server part completes.
 * 
 * The client should:
 * 1. Look up the tool in its isomorphic registry
 * 2. Execute the client part with the serverOutput
 * 3. For client-authority tools: send result back to server
 * 4. Results are merged and continue the conversation
 */
import type { IsomorphicHandoffEvent } from './isomorphic-tools/types'


/**
 * Snapshot of conversation state when handing off to client for tool execution.
 */
export interface ConversationState {
  /** Full message history up to this point */
  messages: Message[]
  /** Text content the assistant generated before requesting tools */
  assistantContent: string
  /** Tool calls the assistant requested (both server and client) - normalized to flat format */
  toolCalls: ToolCallInfo[]
  /** Results from server-side tool execution (already complete) */
  serverToolResults: ServerToolResult[]
}

export interface ServerToolResult {
  id: string
  name: string
  content: string
  isError: boolean
}

export interface ToolCallInfo {
  id: string
  name: string
  arguments: Record<string, unknown>
}

// --- Client Tool Schema (sent from client to server) ---

/**
 * Schema for a client-side tool, sent to the server so it can be
 * included in the LLM request. The server doesn't execute these -
 * it passes them to the LLM and hands back to the client for execution.
 */
export interface ClientToolSchema {
  name: string
  description: string
  parameters: Record<string, unknown>  // JSON Schema
}

// --- Request Types ---

export interface OllamaChatRequest {
  model: string
  messages: Message[]
  stream?: boolean
  tools?: Array<{
    type: 'function'
    function: {
      name: string
      description: string
      parameters: Record<string, unknown>
    }
  }>
}

export interface OllamaChatChunk {
  model: string
  created_at: string
  message: {
    role: string
    content: string
    thinking?: string // DeepSeek-R1 style
    tool_calls?: ToolCall[]
  }
  done: boolean
  done_reason?: string
  total_duration?: number
  load_duration?: number
  prompt_eval_count?: number
  prompt_eval_duration?: number
  eval_count?: number
  eval_duration?: number
  error?: string
}

// Re-export specific types from personas if needed by consumers
export type { Capabilities } from './personas/types'
export type { ServerToolContext, ServerAuthorityContext, IsomorphicHandoffEvent } from './isomorphic-tools/types'
