/**
 * types/patch.ts
 *
 * Types for patches - messages sent from session to React state.
 */
import type { Message } from '../../../lib/chat/types'
import type { ContentMetadata } from './metadata'

// --- Buffer Patches ---

/**
 * Patch emitted when content settles in the buffer.
 */
export type BufferSettledPatch = {
  type: 'buffer_settled'
  content: string // The chunk that just settled
  prev: string // Previous settled total
  next: string // New settled total (prev + content)
  // Processor enrichments (optional, extensible)
  html?: string // Parsed HTML, if markdown processor ran
  ast?: unknown // Parsed AST, for advanced processing
  pass?: 'quick' | 'full' // Progressive enhancement pass
  meta?: ContentMetadata // Content metadata (e.g., code fence info)
  [key: string]: unknown // Allow additional processor fields
}

/**
 * Patch emitted when pending buffer updates.
 */
export type BufferPendingPatch = {
  type: 'buffer_pending'
  content: string // Current pending buffer (full replacement)
}

/**
 * Patch emitted when raw buffer updates.
 */
export type BufferRawPatch = {
  type: 'buffer_raw'
  content: string // Current raw buffer (full replacement)
}

// --- Render Frame Types ---

/**
 * Delta information for animation support.
 *
 * Contains the new content added since the previous frame,
 * enabling smooth animations and transitions in React.
 */
export interface RenderDelta {
  /** The new content added since prev frame */
  added: string
  /** HTML for just the new content (if available) */
  addedHtml?: string
  /** Starting character offset where new content begins */
  startOffset: number
}

/**
 * Reveal hint for animation control.
 *
 * Processors can emit reveal hints to suggest how React should
 * animate the appearance of content.
 */
export interface RevealHint {
  /** How to reveal the content */
  type: 'instant' | 'character' | 'word' | 'line'
  /** Suggested duration in ms (for non-instant reveals) */
  duration?: number
  /** Whether this is the final chunk */
  isComplete?: boolean
}

/**
 * Patch emitted when a new render frame is ready.
 */
export type BufferRenderablePatch = {
  type: 'buffer_renderable'
  /** Previous frame content */
  prev: string
  /** Current frame content */
  next: string
  /** Processed HTML for current frame */
  html?: string
  /** Delta information for animation */
  delta?: RenderDelta
  /** Reveal hint for animation control */
  revealHint?: RevealHint
  /** Timestamp when this frame was produced */
  timestamp?: number
  /** Metadata from processors */
  meta?: ContentMetadata
  /** Allow additional processor fields */
  [key: string]: unknown
}

// --- Client Tool Patches ---

export type ClientToolAwaitingApprovalPatch = {
  type: 'client_tool_awaiting_approval'
  id: string
  name: string
  message: string
}

export type ClientToolExecutingPatch = {
  type: 'client_tool_executing'
  id: string
}

export type ClientToolCompletePatch = {
  type: 'client_tool_complete'
  id: string
  result: string
}

export type ClientToolErrorPatch = {
  type: 'client_tool_error'
  id: string
  error: string
}

export type ClientToolDeniedPatch = {
  type: 'client_tool_denied'
  id: string
  reason: string
}

export type ClientToolProgressPatch = {
  type: 'client_tool_progress'
  id: string
  message: string
}

export type ClientToolPermissionRequestPatch = {
  type: 'client_tool_permission_request'
  id: string
  permissionType: string
}

// --- Isomorphic Tool Patches ---

export type AuthorityMode = 'server' | 'client'

export type IsomorphicToolState =
  | 'pending'
  | 'server_executing'
  | 'awaiting_client_approval'
  | 'client_executing'
  | 'server_validating'
  | 'complete'
  | 'error'
  | 'denied'

export type IsomorphicToolStatePatch = {
  type: 'isomorphic_tool_state'
  id: string
  state: IsomorphicToolState
  authority: AuthorityMode
  serverOutput?: unknown
  clientOutput?: unknown
  error?: string
}

// --- Handoff Patches ---

export interface PendingHandoffState {
  callId: string
  toolName: string
  params: unknown
  data: unknown
  authority: 'server' | 'client'
  usesHandoff: boolean
}

export type PendingHandoffPatch = {
  type: 'pending_handoff'
  handoff: PendingHandoffState
}

export type HandoffCompletePatch = {
  type: 'handoff_complete'
  callId: string
}

// --- Execution Trail Patches ---

export type ExecutionTrailStartPatch = {
  type: 'execution_trail_start'
  callId: string
  toolName: string
}

export type ExecutionTrailStepPatch = {
  type: 'execution_trail_step'
  callId: string
  step: {
    id: string
    kind: 'emit' | 'prompt'
    type?: string
    payload?: unknown
    element?: unknown
    component?: unknown
    timestamp: number
    status: 'pending' | 'complete'
    response?: unknown
  }
  respond?: (response: unknown) => void
}

export type ExecutionTrailCompletePatch = {
  type: 'execution_trail_complete'
  callId: string
  result?: unknown
  error?: string
}

export type ExecutionTrailStepResponsePatch = {
  type: 'execution_trail_step_response'
  stepId: string
  callId: string
  response: unknown
}

// --- Capabilities ---

export interface Capabilities {
  thinking: boolean
  streaming: boolean
  tools: string[]
}

// --- Chat Patch Union ---

export type ChatPatch =
  | { type: 'session_info'; capabilities: Capabilities; persona: string | null }
  | { type: 'user_message'; message: Message; rendered?: string }
  | { type: 'assistant_message'; message: Message; rendered?: string }
  | { type: 'streaming_start' }
  | { type: 'streaming_text'; content: string }
  | { type: 'streaming_thinking'; content: string }
  | { type: 'streaming_end' }
  | { type: 'tool_call_start'; call: { id: string; name: string; arguments: string } }
  | { type: 'tool_call_result'; id: string; result: string }
  | { type: 'tool_call_error'; id: string; error: string }
  | { type: 'abort_complete'; message?: Message; rendered?: string }
  | { type: 'error'; message: string }
  | { type: 'reset' }
  // Buffer patches
  | BufferSettledPatch
  | BufferPendingPatch
  | BufferRawPatch
  | BufferRenderablePatch
  // Client tool patches
  | ClientToolAwaitingApprovalPatch
  | ClientToolExecutingPatch
  | ClientToolCompletePatch
  | ClientToolErrorPatch
  | ClientToolDeniedPatch
  | ClientToolProgressPatch
  | ClientToolPermissionRequestPatch
  // Isomorphic tool patches
  | IsomorphicToolStatePatch
  // Handoff patches
  | PendingHandoffPatch
  | HandoffCompletePatch
  // Execution trail patches
  | ExecutionTrailStartPatch
  | ExecutionTrailStepPatch
  | ExecutionTrailCompletePatch
  | ExecutionTrailStepResponsePatch
