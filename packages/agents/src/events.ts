/**
 * AgentEvent — the canonical, LSN-tagged event vocabulary of the durable stream.
 *
 * Every other view (AG-UI events, A2A task/artifact updates, ChatState) is a
 * projection of AgentEvent. This module defines the union and constructors.
 *
 * (Spec REQ-020 / DD7: AgentEvent generalizes ChatPatch; the
 * `kind: "elicit"|"notify"` hardcode and elicit-envelope wrapping are removed
 * in favour of a typed, schema-driven vocabulary.)
 */

// ============================================================================
// Base
// ============================================================================

export interface AgentEventBase {
  /** Monotonic log sequence number assigned by the stream on append. */
  lsn: number
  /** Wall-clock milliseconds at append time. */
  timestamp: number
}

// ============================================================================
// Conversation events
// ============================================================================

export interface TextDeltaEvent extends AgentEventBase {
  type: 'text_delta'
  /** The message/part this delta belongs to. */
  messageId: string
  /** Sub-session that produced this delta (omitted for the root harness). */
  subSessionId?: string
  delta: string
}

export interface ProgressEvent extends AgentEventBase {
  type: 'progress'
  message: string
  /** Optional completion fraction in [0,1]. */
  fraction?: number
  subSessionId?: string
}

// ============================================================================
// Tool / sub-session lifecycle
// ============================================================================

export interface ToolCallStartEvent extends AgentEventBase {
  type: 'tool_call_start'
  subSessionId: string
  toolName: string
  callId: string
  input: unknown
}

export interface ToolCallEndEvent extends AgentEventBase {
  type: 'tool_call_end'
  subSessionId: string
  callId: string
  result?: unknown
  error?: string
}

export interface SubSessionStartEvent extends AgentEventBase {
  type: 'sub_session_start'
  subSessionId: string
  /** Agent name or tool name being entered. */
  target: string
  input: unknown
}

export interface SubSessionEndEvent extends AgentEventBase {
  type: 'sub_session_end'
  subSessionId: string
  result?: unknown
  error?: string
}

// ============================================================================
// Mid-execution requests (correlated by requestId)
// ============================================================================

export interface ElicitRequestEvent extends AgentEventBase {
  type: 'elicit_request'
  requestId: string
  key: string
  message: string
  /** Optional JSON schema describing the expected response. */
  schema?: unknown
  subSessionId?: string
}

export interface SampleRequestEvent extends AgentEventBase {
  type: 'sample_request'
  requestId: string
  messages: AgentMessage[]
  options?: SampleOptions
  subSessionId?: string
}

// ============================================================================
// Checkpoint / lifecycle
// ============================================================================

export interface CheckpointEvent extends AgentEventBase {
  type: 'checkpoint'
  checkpoint: AgentCheckpoint
}

export interface ResultEvent extends AgentEventBase {
  type: 'result'
  value: unknown
}

export interface ErrorEvent extends AgentEventBase {
  type: 'error'
  message: string
  code?: string
}

export interface CancelledEvent extends AgentEventBase {
  type: 'cancelled'
  reason?: string
}

// ============================================================================
// Union
// ============================================================================

export type AgentEvent =
  | TextDeltaEvent
  | ProgressEvent
  | ToolCallStartEvent
  | ToolCallEndEvent
  | SubSessionStartEvent
  | SubSessionEndEvent
  | ElicitRequestEvent
  | SampleRequestEvent
  | CheckpointEvent
  | ResultEvent
  | ErrorEvent
  | CancelledEvent

// ============================================================================
// Messages (minimal conversation record)
// ============================================================================

export interface AgentMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  /** Sub-session that produced an assistant message, if any. */
  subSessionId?: string
}

// ============================================================================
// Sample (ctx.sample) options
// ============================================================================

export interface SampleOptions {
  prompt?: string
  /** When true, stream text deltas as progress (default true). */
  stream?: boolean
  [key: string]: unknown
}

export interface SampleResult {
  content: string
  /** Raw provider result, opaque to the runtime. */
  raw?: unknown
}

// ============================================================================
// Elicit request/result shapes
// ============================================================================

export interface ElicitRequest {
  message: string
  /** Optional JSON schema describing the expected response. */
  schema?: unknown
  [key: string]: unknown
}

export type ElicitStatus = 'accepted' | 'declined' | 'cancelled'

export interface ElicitResult {
  status: ElicitStatus
  /** The user's response when accepted. */
  value?: unknown
  /** Free-text reason when not accepted. */
  reason?: string
}

// ============================================================================
// Checkpoint (snapshot+delta restoration — REQ-011/013)
// ============================================================================

export interface AgentCheckpoint {
  contextId: string
  /** LSN of the last event applied when this checkpoint was captured. */
  atLsn: number
  messages: AgentMessage[]
  /** Pending sub-session references (tool/sub-agent callIds awaiting replies). */
  pendingSubSessions: PendingSubSessionRef[]
  /** Pending elicit/sample requestIds awaiting responses. */
  pendingRequests: PendingRequestRef[]
  /** Externalized harness state (ctx.state). */
  state: AgentState
}

export interface PendingSubSessionRef {
  subSessionId: string
  target: string
  kind: 'tool' | 'agent'
}

export interface PendingRequestRef {
  requestId: string
  type: 'elicit' | 'sample'
  key?: string
}

export interface AgentState {
  [key: string]: unknown
}

/** Distributive Omit over the AgentEvent union (preserves per-variant keys). */
export type DistributiveOmit<T, K extends keyof AgentEventBase> = T extends AgentEvent
  ? Omit<T, K>
  : never
