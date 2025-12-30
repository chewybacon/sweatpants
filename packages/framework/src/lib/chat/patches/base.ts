/**
 * lib/chat/patches/base.ts
 *
 * Base types for the patch system.
 * Patches are messages sent from the session layer to React state.
 */

import type { Message } from '../types'
import type { Capabilities } from '../core-types'

// =============================================================================
// CORE PATCHES
// =============================================================================

/**
 * Session info patch - sent at the start of a session.
 */
export interface SessionInfoPatch {
  type: 'session_info'
  capabilities: Capabilities
  persona: string | null
}

/**
 * User message patch - sent when a user message is added.
 */
export interface UserMessagePatch {
  type: 'user_message'
  message: Message
  rendered?: string
}

/**
 * Assistant message patch - sent when an assistant message is finalized.
 */
export interface AssistantMessagePatch {
  type: 'assistant_message'
  message: Message
  rendered?: string
}

/**
 * Streaming start patch - sent when streaming begins.
 */
export interface StreamingStartPatch {
  type: 'streaming_start'
}

/**
 * Streaming text patch - sent for each text chunk.
 */
export interface StreamingTextPatch {
  type: 'streaming_text'
  content: string
}

/**
 * Streaming thinking patch - sent for thinking/reasoning chunks.
 */
export interface StreamingThinkingPatch {
  type: 'streaming_thinking'
  content: string
}

/**
 * Streaming end patch - sent when streaming completes.
 */
export interface StreamingEndPatch {
  type: 'streaming_end'
}

/**
 * Tool call start patch - sent when a tool call begins.
 */
export interface ToolCallStartPatch {
  type: 'tool_call_start'
  call: {
    id: string
    name: string
    arguments: string
  }
}

/**
 * Tool call result patch - sent when a tool call succeeds.
 */
export interface ToolCallResultPatch {
  type: 'tool_call_result'
  id: string
  result: string
}

/**
 * Tool call error patch - sent when a tool call fails.
 */
export interface ToolCallErrorPatch {
  type: 'tool_call_error'
  id: string
  error: string
}

/**
 * Abort complete patch - sent when streaming is aborted.
 */
export interface AbortCompletePatch {
  type: 'abort_complete'
  message?: Message
  rendered?: string
}

/**
 * Error patch - sent when an error occurs.
 */
export interface ErrorPatch {
  type: 'error'
  message: string
}

/**
 * Reset patch - sent to reset the chat state.
 */
export interface ResetPatch {
  type: 'reset'
}

/**
 * Core patches - the fundamental patches for chat flow.
 */
export type CorePatch =
  | SessionInfoPatch
  | UserMessagePatch
  | AssistantMessagePatch
  | StreamingStartPatch
  | StreamingTextPatch
  | StreamingThinkingPatch
  | StreamingEndPatch
  | ToolCallStartPatch
  | ToolCallResultPatch
  | ToolCallErrorPatch
  | AbortCompletePatch
  | ErrorPatch
  | ResetPatch
