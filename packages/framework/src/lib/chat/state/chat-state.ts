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

import type { Message } from '../types.ts'
import type { Capabilities } from '../core-types.ts'
import type { ToolEmissionState, ToolEmissionTrackingState } from '../patches/emission.ts'
import type { ElicitState, ElicitTrackingState } from '../patches/elicit.ts'
import type { MessagePart } from '../types/chat-message.ts'
import type { ContentPartType } from '../patches/base.ts'

// Re-export emission types for convenience (used by React-local state)
export type { ToolEmissionState, ToolEmissionTrackingState }

// Re-export elicit types
export type { ElicitState, ElicitTrackingState }

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

  /**
   * Pending elicitations for tools that need client input.
   * Keyed by tool call ID.
   *
   * This is the unified elicitation system used by both MCP tools and isomorphic tools.
   * The elicitation flow is:
   * 1. Server emits elicit_start when tool begins
   * 2. Server emits elicit when tool needs client input
   * 3. Client renders UI based on elicit key and context
   * 4. User responds, client sends elicit_response
   * 5. Server emits elicit_complete when tool finishes
   */
  pendingElicits: Record<string, ElicitTrackingState>

  /**
   * Tool emissions for isomorphic tools (ctx.render pattern).
   * Keyed by tool call ID.
   *
   * The emission flow is:
   * 1. Server emits tool_emission_start when tool begins
   * 2. Server emits tool_emission when tool calls ctx.render()
   * 3. Client renders component based on emission payload
   * 4. User responds, client sends tool_emission_response
   * 5. Server emits tool_emission_complete when tool finishes
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
  pendingElicits: {},
  toolEmissions: {},
}
