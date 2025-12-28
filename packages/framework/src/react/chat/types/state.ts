/**
 * types/state.ts
 *
 * Types for chat session state.
 */
import type { Message } from '../../../lib/chat/types'
import type { SettleMeta } from './settler'
import type {
  RenderDelta,
  RevealHint,
  Capabilities,
  PendingHandoffState,
} from './patch'

// --- Response Steps ---

/**
 * A completed step in the response chain.
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
 * The currently streaming step.
 */
export interface ActiveStep {
  type: 'thinking' | 'text'
  content: string
}

// --- Rendered Content ---

/**
 * Rendered output for a message.
 */
export interface RenderedContent {
  output?: string
}

// --- Timeline Types ---

export type TimelineItem =
  | TimelineUserMessage
  | TimelineAssistantText
  | TimelineThinking
  | TimelineToolCall
  | TimelineStep

export interface TimelineUserMessage {
  type: 'user'
  id: string
  content: string
  timestamp: number
}

export interface TimelineAssistantText {
  type: 'assistant_text'
  id: string
  content: string
  timestamp: number
}

export interface TimelineThinking {
  type: 'thinking'
  id: string
  content: string
  timestamp: number
}

export interface TimelineToolCall {
  type: 'tool_call'
  id: string
  callId: string
  toolName: string
  input: unknown
  state: 'running' | 'complete' | 'error'
  output?: unknown
  error?: string
  timestamp: number
}

export interface TimelineStep {
  type: 'step'
  id: string
  callId: string
  stepType: string
  payload: unknown
  state: 'pending' | 'complete'
  response?: unknown
  element?: unknown
  respond?: (response: unknown) => void
  timestamp: number
}

// --- Pending States ---

export interface PendingClientToolState {
  id: string
  name: string
  state: 'awaiting_approval' | 'executing' | 'complete' | 'error' | 'denied'
  approvalMessage?: string
  progressMessage?: string
  result?: string
  error?: string
  denialReason?: string
  permissionType?: string
}

export interface PendingStepState {
  stepId: string
  callId: string
  kind: 'emit' | 'prompt'
  type?: string
  payload?: unknown
  element?: unknown
  component?: unknown
  timestamp: number
  respond: (response: unknown) => void
}

export interface ExecutionTrailState {
  callId: string
  toolName: string
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
  status: 'running' | 'complete' | 'error'
  startedAt: number
  completedAt?: number
  result?: unknown
  error?: string
}

// --- Chat State ---

export interface ChatState {
  messages: Message[]
  timeline: TimelineItem[]
  rendered: Record<string, RenderedContent>
  currentResponse: ResponseStep[]
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
      meta?: SettleMeta
    }
  }

  pendingClientTools: Record<string, PendingClientToolState>
  pendingHandoffs: Record<string, PendingHandoffState>
  pendingSteps: Record<string, PendingStepState>
  executionTrails: Record<string, ExecutionTrailState>
}

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
}
