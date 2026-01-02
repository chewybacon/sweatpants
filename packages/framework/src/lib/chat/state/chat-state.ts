/**
 * lib/chat/state/chat-state.ts
 *
 * Chat state types for the React chat session.
 *
 * ## Parts-Based Model
 *
 * The state uses a parts-based model where streaming content is organized
 * into ordered parts (text, reasoning, tool-call, etc.). Each content part
 * can have its own Frame from the pipeline.
 *
 * During streaming:
 * - `streamingParts` accumulates completed and active parts
 * - `activePartId` indicates which part is currently receiving content
 * - When content type switches, the active part is finalized and a new one starts
 *
 * On streaming end:
 * - All parts are finalized
 * - A complete ChatMessage is added to `messages`
 */

import type { Message } from '../types'
import type { Capabilities } from '../core-types'
import type { PendingHandoffState } from '../patches/handoff'
import type { ToolEmissionState, ToolEmissionTrackingState } from '../patches/emission'
import type { MessagePart, TextPart, ReasoningPart, ToolCallPart } from '../types/chat-message'
import type { ContentPartType } from '../patches/base'

// Re-export emission types for convenience
export type { ToolEmissionState, ToolEmissionTrackingState }

// =============================================================================
// STREAMING PARTS STATE
// =============================================================================

/**
 * State for the currently streaming message.
 *
 * Parts are accumulated as the response streams in. When content type
 * switches (reasoning → text, text → tool_call), the current part is
 * finalized and a new one starts.
 */
export interface StreamingPartsState {
  /** Parts accumulated so far (includes active part) */
  parts: MessagePart[]
  /** ID of the currently streaming part (null if none active) */
  activePartId: string | null
  /** Type of the currently streaming part */
  activePartType: ContentPartType | 'tool-call' | null
}

// =============================================================================
// PENDING STATES
// =============================================================================

/**
 * State of a pending client tool (for UI rendering).
 */
export interface PendingClientToolState {
  /** Tool call ID */
  id: string
  /** Tool name */
  name: string
  /** Current state */
  state: 'awaiting_approval' | 'executing' | 'complete' | 'error' | 'denied'
  /** Approval message to display */
  approvalMessage?: string
  /** Progress message during execution */
  progressMessage?: string
  /** Result if complete */
  result?: string
  /** Error message if failed */
  error?: string
  /** Denial reason */
  denialReason?: string
  /** Permission type if this is a permission request */
  permissionType?: string
}

// =============================================================================
// CHAT STATE
// =============================================================================

/**
 * Complete chat session state.
 */
export interface ChatState {
  /** All completed messages in the conversation */
  messages: Message[]

  /**
   * Finalized parts for completed messages.
   * Keyed by message ID. Stores the rendered parts (with frames) when a message completes.
   * This is separate from Message because Message is for LLM API, parts are for UI rendering.
   */
  finalizedParts: Record<string, MessagePart[]>

  /** Whether we're currently streaming a response */
  isStreaming: boolean

  /**
   * State for the currently streaming message.
   * Only meaningful when isStreaming is true.
   */
  streaming: StreamingPartsState

  /** Current error, if any */
  error: string | null

  /** Model/provider capabilities */
  capabilities: Capabilities | null

  /** Active persona name */
  persona: string | null

  /** Pending client tools awaiting approval or executing */
  pendingClientTools: Record<string, PendingClientToolState>

  /** Pending tool handoffs waiting for React UI handlers */
  pendingHandoffs: Record<string, PendingHandoffState>

  /**
   * Active tool emissions from ctx.render() pattern.
   * Keyed by tool call ID.
   *
   * When a tool completes, emissions collapse into a trace in the tool message.
   */
  toolEmissions: Record<string, ToolEmissionTrackingState>
}

/**
 * Initial chat state.
 */
export const initialChatState: ChatState = {
  messages: [],
  finalizedParts: {},
  isStreaming: false,
  streaming: {
    parts: [],
    activePartId: null,
    activePartType: null,
  },
  error: null,
  capabilities: null,
  persona: null,
  pendingClientTools: {},
  pendingHandoffs: {},
  toolEmissions: {},
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Get the currently active content part (text or reasoning).
 */
export function getActiveContentPart(state: ChatState): TextPart | ReasoningPart | null {
  if (!state.streaming.activePartId) return null

  const part = state.streaming.parts.find(p => p.id === state.streaming.activePartId)
  if (!part) return null

  if (part.type === 'text' || part.type === 'reasoning') {
    return part
  }

  return null
}

/**
 * Get all tool call parts from the streaming state.
 */
export function getStreamingToolCalls(state: ChatState): ToolCallPart[] {
  return state.streaming.parts.filter(
    (p): p is ToolCallPart => p.type === 'tool-call'
  )
}

/**
 * Find a streaming part by ID.
 */
export function findStreamingPart(state: ChatState, partId: string): MessagePart | undefined {
  return state.streaming.parts.find(p => p.id === partId)
}

/**
 * Update a streaming part by ID.
 */
export function updateStreamingPart(
  state: ChatState,
  partId: string,
  updater: (part: MessagePart) => MessagePart
): ChatState {
  return {
    ...state,
    streaming: {
      ...state.streaming,
      parts: state.streaming.parts.map(p =>
        p.id === partId ? updater(p) : p
      ),
    },
  }
}

// =============================================================================
// LEGACY TYPE ALIASES (for migration)
// =============================================================================

/**
 * @deprecated Use StreamingPartsState instead.
 */
export type ResponseStep =
  | { type: 'thinking'; content: string }
  | {
      type: 'tool_call'
      id: string
      name: string
      arguments: string
      result?: string
      error?: string
      state: 'pending' | 'complete' | 'error'
    }
  | { type: 'text'; content: string }

/**
 * @deprecated Use StreamingPartsState instead.
 */
export interface ActiveStep {
  type: 'thinking' | 'text'
  content: string
}

/**
 * @deprecated No longer needed with parts-based model.
 */
export interface RenderedContent {
  output?: string
}
