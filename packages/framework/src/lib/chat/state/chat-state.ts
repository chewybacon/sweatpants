/**
 * lib/chat/state/chat-state.ts
 *
 * Chat state types for the React chat session.
 */

import type { Message } from '../types'
import type {
  Capabilities,
  ContentMetadata,
  RenderDelta,
  RevealHint,
} from '../core-types'
import type { PendingHandoffState } from '../patches/handoff'
import type { ToolEmissionState, ToolEmissionTrackingState } from '../patches/emission'
import type { TimelineItem } from './timeline'

// Re-export emission types for convenience
export type { ToolEmissionState, ToolEmissionTrackingState }

// =============================================================================
// RESPONSE STEPS
// =============================================================================

/**
 * A completed step in the response chain.
 * Steps accumulate as the model thinks, calls tools, and generates text.
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
 * The currently streaming step (actively receiving chunks).
 */
export interface ActiveStep {
  type: 'thinking' | 'text'
  content: string
}

// =============================================================================
// RENDERED CONTENT
// =============================================================================

/**
 * Rendered output for a message.
 */
export interface RenderedContent {
  output?: string
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

// NOTE: PendingStepState and ExecutionTrailState were removed in favor of ToolEmissionState
// The new emission system uses toolEmissions instead of pendingSteps/executionTrails

// =============================================================================
// CHAT STATE
// =============================================================================

/**
 * Complete chat session state.
 */
export interface ChatState {
  /** All messages in the conversation */
  messages: Message[]

  /**
   * Unified timeline - everything in render order.
   *
   * This is the primary data structure for rendering chat UI.
   * Contains user messages, assistant text, tool calls, and interactive steps
   * all in one flat array.
   */
  timeline: TimelineItem[]

  /**
   * Rendered content for each message, keyed by message ID.
   */
  rendered: Record<string, RenderedContent>

  /** Completed steps in the current response being built */
  currentResponse: ResponseStep[]

  /** Currently streaming step (actively receiving chunks) */
  activeStep: ActiveStep | null

  isStreaming: boolean
  error: string | null
  capabilities: Capabilities | null
  persona: string | null

  /**
   * Buffer state for rendering transforms.
   */
  buffer: {
    settled: string
    pending: string
    settledHtml: string
    renderable?: {
      prev: string
      next: string
      html?: string
      delta?: RenderDelta
      revealHint?: RevealHint
      timestamp?: number
      meta?: ContentMetadata
    }
  }

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
  timeline: [],
  rendered: {},
  currentResponse: [],
  activeStep: null,
  isStreaming: false,
  error: null,
  capabilities: null,
  persona: null,
  buffer: {
    settled: '',
    pending: '',
    settledHtml: '',
    renderable: {
      prev: '',
      next: '',
    },
  },
  pendingClientTools: {},
  pendingHandoffs: {},
  toolEmissions: {},
}
