/**
 * types/session.ts
 *
 * Types for session configuration and streaming.
 */
import type { Operation, Channel } from 'effection'
import type { IsomorphicHandoffEvent } from '../../../lib/chat/types'
import type { ChatPatch } from './patch'
import type { MessageRenderer } from './processor'

// --- Stream Result Types ---

export type StreamResult = StreamCompleteResult | StreamIsomorphicHandoffResult

export interface StreamCompleteResult {
  type: 'complete'
  text: string
}

export interface StreamIsomorphicHandoffResult {
  type: 'isomorphic_handoff'
  handoffs: IsomorphicHandoffEvent[]
  conversationState: ConversationState
}

// --- API Message ---

export interface ApiMessage {
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
  tool_calls?: Array<{
    id: string
    function: {
      name: string
      arguments: Record<string, unknown>
    }
  }>
  tool_call_id?: string
}

// --- Conversation State ---

export interface ConversationState {
  messages: ApiMessage[]
  assistantContent: string
  toolCalls: ToolCallInfo[]
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

// --- Streamer Type ---

export type Streamer = (
  messages: ApiMessage[],
  patches: Channel<ChatPatch, void>,
  options: Omit<SessionOptions, 'streamer'>
) => Operation<StreamResult>

// --- Session Options ---

export interface SessionOptions {
  baseUrl?: string
  enabledTools?: string[] | boolean
  systemPrompt?: string
  persona?: string
  personaConfig?: Record<string, boolean | number | string>
  enableOptionalTools?: string[]
  effort?: 'auto' | 'low' | 'medium' | 'high'
  transforms?: PatchTransform[]
  renderer?: MessageRenderer
  streamer?: Streamer
  preservePartialOnAbort?: boolean
  abortSuffix?: string
}

// --- Transform Type ---

export type PatchTransform = (
  input: Channel<ChatPatch, void>,
  output: Channel<ChatPatch, void>
) => Operation<void>

// --- Stream Events ---

export interface TokenUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

export interface ConversationStateStreamEvent {
  type: 'conversation_state'
  conversationState: ConversationState
}

export interface IsomorphicHandoffStreamEvent {
  type: 'isomorphic_handoff'
  callId: string
  toolName: string
  params: unknown
  serverOutput: unknown
  authority: 'server' | 'client'
  usesHandoff?: boolean
}

export type StreamEvent =
  | { type: 'session_info'; capabilities: { thinking: boolean; streaming: boolean; tools: string[] }; persona: string | null }
  | { type: 'text'; content: string }
  | { type: 'thinking'; content: string }
  | { type: 'tool_calls'; calls: { id: string; name: string; arguments: any }[] }
  | { type: 'tool_result'; id: string; name: string; content: string }
  | { type: 'tool_error'; id: string; name: string; message: string }
  | { type: 'complete'; text: string; usage?: TokenUsage }
  | { type: 'error'; message: string; recoverable: boolean }
  | IsomorphicHandoffStreamEvent
  | ConversationStateStreamEvent

// --- Commands ---

export type ChatCommand =
  | { type: 'send'; content: string }
  | {
      type: 'abort'
      partialContent?: string
      partialHtml?: string
    }
  | { type: 'reset' }
