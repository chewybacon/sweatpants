/**
 * lib/chat/patches/base.ts
 *
 * Base types for the patch system.
 * Patches are messages sent from the session layer to React state.
 *
 * ## Parts-Based Model
 *
 * The streaming patches support a parts-based model where content is organized
 * into ordered parts (text, reasoning, tool-call, etc.). Each content part
 * can have its own Frame from the pipeline.
 *
 * Part switching happens implicitly:
 * - streaming_text with no prior content → starts 'text' part
 * - streaming_reasoning with no prior content → starts 'reasoning' part
 * - streaming_text after streaming_reasoning → commits reasoning, starts text
 * - tool_call_start after streaming_text → commits text, starts tool-call
 */

import type { Message } from '../types.ts'
import type { Capabilities } from '../core-types.ts'
import type { Frame } from '../../../react/chat/pipeline/types.ts'

// =============================================================================
// CONTENT PART TYPES
// =============================================================================

/**
 * Types of content that can be streamed through the pipeline.
 */
export type ContentPartType = 'text' | 'reasoning'

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
 * Streaming reasoning patch - sent for reasoning/thinking chunks.
 *
 * Note: This replaces 'streaming_thinking' - we use 'reasoning' to align
 * with Vercel AI SDK naming conventions.
 */
export interface StreamingReasoningPatch {
  type: 'streaming_reasoning'
  content: string
}

/**
 * Streaming end patch - sent when streaming completes.
 */
export interface StreamingEndPatch {
  type: 'streaming_end'
}

/**
 * Part frame patch - sent when a content part's frame is updated.
 *
 * This is emitted by the pipeline transform when it processes content
 * and produces a new frame for the current part.
 */
export interface PartFramePatch {
  type: 'part_frame'
  /** Which type of part this frame is for */
  partType: ContentPartType
  /** Part ID (stable identifier) */
  partId: string
  /** The rendered frame */
  frame: Frame
}

/**
 * Part end patch - sent when a content part is finalized.
 *
 * This happens when:
 * - Content type switches (reasoning → text)
 * - Streaming ends
 * - Tool call starts
 */
export interface PartEndPatch {
  type: 'part_end'
  /** Part type (text or reasoning) */
  partType: ContentPartType
  /** Part ID that was finalized */
  partId: string
  /** Final frame for this part */
  frame: Frame
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
  | StreamingReasoningPatch
  | StreamingEndPatch
  | PartFramePatch
  | PartEndPatch
  | ToolCallStartPatch
  | ToolCallResultPatch
  | ToolCallErrorPatch
  | AbortCompletePatch
  | ErrorPatch
  | ResetPatch
