/**
 * Unified tool/agent event and exchange data model.
 *
 * This module implements the content-part Message model and interrupt/exchange
 * vocabulary from `.pi/specs/unified-tool-model-spec.md` while retaining a few
 * migration aliases (`requestId`, `tool_call_end`, `cancelled`, `status`) used
 * by the stage-1 agent tests and legacy framework adapters.
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
// Content-part messages (REQ-001)
// ============================================================================

export type Role = 'system' | 'user' | 'assistant'
export type LogLevel = 'debug' | 'info' | 'warning' | 'error'

export interface Message {
  id: string
  role: Role
  content: ContentPart[]
  /** Sub-session that produced this message, if any. */
  subSessionId?: string
}

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | { type: 'audio'; data: string; mimeType: string }
  | {
      type: 'resource'
      resource: { uri: string; text?: string; blob?: string; mimeType?: string }
    }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; toolUseId: string; content: ContentPart[]; isError?: boolean }

export type ContentInput = string | ContentPart | ContentPart[]

let messageSeq = 0

export function nextMessageId(prefix = 'msg'): string {
  messageSeq += 1
  return `${prefix}-${Date.now().toString(36)}-${messageSeq.toString(36)}`
}

export function normalizeContent(content: ContentInput): ContentPart[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  if (Array.isArray(content)) return content
  return [content]
}

export function createMessage(
  role: Role,
  content: ContentInput,
  id = nextMessageId(),
): Message {
  return { id, role, content: normalizeContent(content) }
}

export function messageText(message: { content: ContentInput }): string {
  const parts = normalizeContent(message.content)
  return parts
    .map((part) => {
      if (part.type === 'text') return part.text
      if (part.type === 'tool_use') return JSON.stringify(part.input)
      if (part.type === 'tool_result') return part.content.map((p) => (p.type === 'text' ? p.text : '')).join('')
      if (part.type === 'resource') return part.resource.text ?? part.resource.uri
      return ''
    })
    .join('')
}

// Parent-spec migration alias. It is now content-part shaped.
export type AgentMessage = Message

// ============================================================================
// Exchanges (REQ-002/003/004/026)
// ============================================================================

export interface ElicitExchange<TContext = unknown> {
  context: TContext
  request: Message & { role: 'assistant' }
  response: Message & { role: 'user' }
  messages: [Message, Message]
  withArguments(fn: (context: TContext) => Record<string, unknown>): [Message, Message]
}

export interface SampleExchange<TParsed = undefined> {
  request: Message & { role: 'user' }
  response: Message & { role: 'assistant' }
  messages: Message[]
  parsed: TParsed | undefined
  parseError?: string
}

export interface ToolCallExchange {
  request: Message & { role: 'assistant' }
  response: Message & { role: 'user' }
  messages: Message[]
}

export interface AgentCallExchange {
  request: Message & { role: 'user' }
  response: Message & { role: 'assistant' }
  messages: Message[]
}

export interface ToolCallResult<T = unknown> {
  result: T
  exchange: ToolCallExchange
}

export interface AgentCallResult<T = unknown> {
  result: T
  exchange?: AgentCallExchange
}

// ============================================================================
// Sample options/result (REQ-003/027)
// ============================================================================

export interface SampleOptions<TParsed = undefined> {
  /** Type-only brand so SampleOptions carries the structured parsed type. */
  readonly __parsedType?: TParsed
  prompt?: string
  messages?: Message[]
  systemPrompt?: string
  schema?: unknown
  maxTokens?: number
  modelPreferences?: {
    hints?: Array<{ name: string }>
    costPriority?: number
    speedPriority?: number
    intelligencePriority?: number
  }
  /** Legacy option; server-resolved samples still stream progress by default. */
  stream?: boolean
  [key: string]: unknown
}

export interface SampleResult<TParsed = undefined> {
  content: string
  exchange: SampleExchange<TParsed>
  parsed: TParsed | undefined
  parseError?: string
  raw?: unknown
}

// ============================================================================
// Elicit request/result shapes (REQ-002/007/008)
// ============================================================================

export type ElicitMode = 'form' | 'url'
export type InterruptReason = 'tool_call' | 'input_required' | 'confirmation' | `${string}:${string}`

export interface PerCallInterruptOptions {
  reason?: InterruptReason
  expiresAt?: string
  ttlMs?: number
  metadata?: Record<string, unknown>
}

export interface DynamicElicitOptions {
  key: string
  message: string
  responseSchema?: unknown
  contextSchema?: unknown
  context?: unknown
  reason?: InterruptReason
  expiresAt?: string
  ttlMs?: number
  mode?: ElicitMode
  metadata?: Record<string, unknown>
}

/** Legacy structural request accepted by older call sites. */
export interface ElicitRequest {
  message: string
  schema?: unknown
  responseSchema?: unknown
  contextSchema?: unknown
  context?: unknown
  interrupt?: PerCallInterruptOptions
  [key: string]: unknown
}

export type ElicitStatus = 'accepted' | 'declined' | 'cancelled'

export type ElicitResult<TContext = unknown, TResponse = unknown> =
  | {
      action: 'accept'
      content: TResponse
      exchange: ElicitExchange<TContext>
      /** Legacy migration aliases. */
      status: 'accepted'
      value: TResponse
    }
  | { action: 'decline'; status: 'declined'; reason?: string }
  | { action: 'cancel'; status: 'cancelled'; reason?: string }

export type RawElicitResult<TResponse = unknown> =
  | { action: 'accept'; content: TResponse }
  | { action: 'decline'; reason?: string }
  | { action: 'cancel'; reason?: string }

export type LegacyElicitResponse<TResponse = unknown> =
  | { status: 'accepted'; value: TResponse; reason?: string }
  | { status: 'declined'; reason?: string }
  | { status: 'cancelled'; reason?: string }

export type IncomingElicitResponse<TResponse = unknown> =
  | RawElicitResult<TResponse>
  | LegacyElicitResponse<TResponse>
  | ElicitResult<unknown, TResponse>

// ============================================================================
// Interrupt descriptors / checkpoints (REQ-014/017)
// ============================================================================

export interface InterruptDescriptor {
  id: string
  key: string
  seq: number
  reason: InterruptReason
  message: string
  responseSchema?: unknown
  contextSchema?: unknown
  context?: unknown
  toolCallId?: string
  expiresAt?: string
  metadata?: Record<string, unknown>
}

export interface PendingRef {
  subSessionId: string
  target: string
  kind: 'tool' | 'agent'
}

export interface Checkpoint {
  contextId: string
  atLsn: number
  messages: Message[]
  pendingInterruptIds: string[]
  pendingSubSessions: PendingRef[]
  state: Record<string, unknown>
}

export type AgentCheckpoint = Checkpoint & {
  /** Stage-1 migration alias for pendingInterruptIds. */
  pendingRequests?: PendingRequestRef[]
}

export interface PendingSubSessionRef extends PendingRef {}

export interface PendingRequestRef {
  requestId: string
  type: 'elicit' | 'sample'
  key?: string
}

export interface AgentState {
  [key: string]: unknown
}

// ============================================================================
// Events (REQ-014/017/018/023)
// ============================================================================

export interface TextDeltaEvent extends AgentEventBase {
  type: 'text_delta'
  messageId: string
  subSessionId?: string
  delta: string
}

export interface ProgressEvent extends AgentEventBase {
  type: 'progress'
  message: string
  fraction?: number
  level?: LogLevel
  subSessionId?: string
}

export interface LogEvent extends AgentEventBase {
  type: 'log'
  level: LogLevel
  message: string
  subSessionId?: string
}

export interface ToolCallStartEvent extends AgentEventBase {
  type: 'tool_call_start'
  subSessionId: string
  toolName?: string
  /** Spec field name. */
  name: string
  callId: string
  input: unknown
}

export interface ToolCallResultEvent extends AgentEventBase {
  type: 'tool_call_result'
  subSessionId: string
  callId: string
  result?: unknown
  error?: string
  exchange?: ToolCallExchange
}

/** Parent-spec migration alias. */
export interface ToolCallEndEvent extends AgentEventBase {
  type: 'tool_call_end'
  subSessionId: string
  callId: string
  result?: unknown
  error?: string
  exchange?: ToolCallExchange
}

export interface SubSessionStartEvent extends AgentEventBase {
  type: 'sub_session_start'
  subSessionId: string
  target: string
  input: unknown
}

export interface SubSessionEndEvent extends AgentEventBase {
  type: 'sub_session_end'
  subSessionId: string
  result?: unknown
  error?: string
  exchange?: AgentCallExchange
}

export interface ElicitRequestEvent extends AgentEventBase {
  type: 'elicit_request'
  interrupt: InterruptDescriptor
  /** Migration aliases for old consumers. */
  requestId: string
  key: string
  message: string
  schema?: unknown
  subSessionId?: string
}

export interface SampleRequestEvent extends AgentEventBase {
  type: 'sample_request'
  interrupt: InterruptDescriptor
  sample: SampleOptions<any>
  /** Migration aliases for old consumers. */
  requestId: string
  messages: Message[]
  options?: SampleOptions<any>
  subSessionId?: string
}

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

export interface AbortedEvent extends AgentEventBase {
  type: 'aborted'
  reason?: string
}

/** Parent-spec migration alias for terminal abort. */
export interface CancelledEvent extends AgentEventBase {
  type: 'cancelled'
  reason?: string
}

export type AgentEvent =
  | TextDeltaEvent
  | ProgressEvent
  | LogEvent
  | ToolCallStartEvent
  | ToolCallResultEvent
  | ToolCallEndEvent
  | SubSessionStartEvent
  | SubSessionEndEvent
  | ElicitRequestEvent
  | SampleRequestEvent
  | CheckpointEvent
  | ResultEvent
  | ErrorEvent
  | AbortedEvent
  | CancelledEvent

/** Distributive Omit over the AgentEvent union (preserves per-variant keys). */
export type DistributiveOmit<T, K extends keyof AgentEventBase> = T extends AgentEvent
  ? Omit<T, K>
  : never
