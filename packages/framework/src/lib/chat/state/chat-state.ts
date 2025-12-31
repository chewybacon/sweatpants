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

/**
 * State of a pending step waiting for user response.
 */
export interface PendingStepState {
  /** The step ID */
  stepId: string
  /** The tool call ID this step belongs to */
  callId: string
  /** Step kind (should be 'prompt' for pending steps) */
  kind: 'emit' | 'prompt'
  /** Step type for routing (or '__react__' for render steps) */
  type?: string
  /** Payload for type-based steps */
  payload?: unknown
  /** React element for render steps */
  element?: unknown
  /** React component for factory pattern (ctx.step) */
  component?: unknown
  /** Timestamp */
  timestamp: number
  /** Respond function - call this to complete the step */
  respond: (response: unknown) => void
}

/**
 * State of an execution trail for a tool call.
 */
export interface ExecutionTrailState {
  /** The tool call ID */
  callId: string
  /** The tool name */
  toolName: string
  /** All steps in order */
  steps: Array<{
    id: string
    kind: 'emit' | 'prompt'
    type?: string
    payload?: unknown
    element?: unknown
    timestamp: number
    status: 'pending' | 'complete'
    response?: unknown
  }>
  /** Trail status */
  status: 'running' | 'complete' | 'error'
  /** Start timestamp */
  startedAt: number
  /** End timestamp */
  completedAt?: number
  /** Result if complete */
  result?: unknown
  /** Error if failed */
  error?: string
}

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

  /** Pending steps from tools using ctx.render() pattern */
  pendingSteps: Record<string, PendingStepState>

  /** Active execution trails for tools using ctx.render() pattern */
  executionTrails: Record<string, ExecutionTrailState>

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
  pendingSteps: {},
  executionTrails: {},
  toolEmissions: {},
}
