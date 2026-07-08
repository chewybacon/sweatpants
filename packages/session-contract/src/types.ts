import type { Operation, Stream } from 'effection'

export type WaitKind = 'message' | 'elicit' | 'sample' | 'call'
export type WaitFate = 'answered' | 'expired' | 'orphaned' | 'cancelled'
export type TerminalOutcome = 'result' | 'error' | 'cancelled'
export type AuthoringMode = 'body' | 'fold'
export type SessionLifecycle = 'running' | 'parked' | 'completed' | 'failed' | 'cancelled'

export interface TypedFailure {
  ok: false
  code: SessionErrorCode | (string & {})
  message?: string
  details?: unknown
}

export interface Success<T = unknown> {
  ok: true
  value: T
}

export type AnswerPayload<T = unknown> = Success<T> | TypedFailure

export type SessionErrorCode =
  | 'resume_unavailable'
  | 'session_lost'
  | 'idempotency_conflict'
  | 'unknown_wait'
  | 'wait_kind_mismatch'
  | 'unknown_target'
  | 'unsupported_operation'
  | 'terminal_session'
  | 'invalid_log_record'

export class SessionContractError extends Error {
  readonly code: SessionErrorCode | (string & {})
  readonly details?: unknown

  constructor(code: SessionErrorCode | (string & {}), message?: string, details?: unknown) {
    super(message ?? code)
    this.name = 'SessionContractError'
    this.code = code
    this.details = details
  }
}

export interface ElicitWaitPayload {
  key: string
  message: string
  responseSchema: unknown
  context?: unknown
  contextSchema?: unknown
  metadata?: Record<string, unknown>
}

export interface SampleWaitPayload {
  messages: unknown[]
  options?: Record<string, unknown>
}

export interface CallWaitPayload {
  target: string
  input: unknown
}

export interface MessageWaitPayload {
  prompt?: string
  metadata?: Record<string, unknown>
}

export type WaitPayloadByKind = {
  message: MessageWaitPayload
  elicit: ElicitWaitPayload
  sample: SampleWaitPayload
  call: CallWaitPayload
}

export type WaitPayload = WaitPayloadByKind[WaitKind]

export interface LogRecordBase {
  lsn: number
  meta?: Record<string, unknown>
}

export interface WaitRecord<K extends WaitKind = WaitKind> extends LogRecordBase {
  kind: 'wait'
  waitSeq: number
  wait: K
  payload: WaitPayloadByKind[K]
  expiresAt?: string
}

export interface AnswerRecord extends LogRecordBase {
  kind: 'answer'
  waitSeq?: number
  wait?: WaitKind
  payload: AnswerPayload
  idempotencyKey: string
  resolution?: ResolutionMeta
}

export interface EmissionRecord extends LogRecordBase {
  kind: 'emission'
  payload: unknown
}

export interface CheckpointRecord extends LogRecordBase {
  kind: 'checkpoint'
  mode: AuthoringMode
  waitSeqWatermark: number
  state?: unknown
}

export interface TerminalRecord extends LogRecordBase {
  kind: 'terminal'
  outcome: TerminalOutcome
  payload?: unknown
}

/**
 * Observable form of non-answered wait fates. The normative grammar counts this
 * as answer-family bookkeeping; it is an explicit TypeScript variant so
 * validators and conformance tests can inspect it directly.
 */
export interface FateRecord extends LogRecordBase {
  kind: 'fate'
  waitSeq: number
  fate: Exclude<WaitFate, 'answered'>
  reason?: string
  payload?: unknown
}

export type LogRecord =
  | WaitRecord
  | AnswerRecord
  | EmissionRecord
  | CheckpointRecord
  | TerminalRecord
  | FateRecord

export interface PendingWait {
  waitSeq: number
  token: string
  kind: WaitKind
  expiresAt?: string
  payload: WaitPayload
}

export interface SessionStatus {
  state: SessionLifecycle
  pendingWaits: PendingWait[]
  terminal?: { outcome: TerminalOutcome; payload?: unknown }
}

export interface SendAck {
  lsn: number
  idempotencyKey: string
}

export interface RespondAck {
  lsn: number
  waitSeq: number
  idempotencyKey: string
}

export type RespondIfPendingResult =
  | { type: 'accepted'; ack: RespondAck }
  | { type: 'not_pending'; waitSeq: number; reason: 'unknown' | 'answered' | 'fated' | 'expired' }
  | { type: 'terminal'; waitSeq: number; outcome: TerminalOutcome; payload?: unknown }

export interface ResolutionMeta {
  provider?: string
  childSessionId?: string
  durationMs?: number
  [key: string]: unknown
}

export interface MessageInput {
  role?: string
  content: unknown
  id?: string
  [key: string]: unknown
}

export interface Session {
  readonly id: string
  events(afterLSN?: number): Stream<LogRecord, void>
  send(message: MessageInput, opts?: { idempotencyKey?: string }): Operation<SendAck>
  respond(waitToken: string, payload: unknown, opts?: { idempotencyKey?: string; wait?: WaitKind; resolution?: ResolutionMeta }): Operation<RespondAck>
  cancel(reason?: string): Operation<void>
  status(): Operation<SessionStatus>
}

export interface FoldSessionHost extends Session {
  records(): Operation<LogRecord[]>
  emitWait<K extends WaitKind>(wait: K, payload: WaitPayloadByKind[K], options?: { expiresAt?: string }): Operation<WaitRecord<K>>
  emitEmission(payload: unknown): Operation<EmissionRecord>
  checkpoint(mode: AuthoringMode, state?: unknown): Operation<CheckpointRecord>
  terminal(outcome: TerminalOutcome, payload?: unknown): Operation<TerminalRecord>
  expire(waitSeq: number, reason?: string): Operation<FateRecord>
  orphan(waitSeq: number, reason?: string): Operation<FateRecord>
  respondIfPending(
    waitToken: string,
    payload: unknown,
    opts?: { idempotencyKey?: string; wait?: WaitKind; resolution?: ResolutionMeta },
  ): Operation<RespondIfPendingResult>
}

export interface CapabilityDeclaration<I = unknown, O = unknown> {
  input?: unknown
  output?: unknown
  description?: string
  _input?: I
  _output?: O
}

export type CapabilityMap = Record<string, CapabilityDeclaration>

export interface CapabilityListingEntry {
  name: string
  input?: unknown
  output?: unknown
  description?: string
}

export interface CapabilityResolver {
  call(target: string, input: unknown): Operation<AnswerPayload>
}

export interface ModelProvider {
  sample(request: SampleWaitPayload): Operation<AnswerPayload>
}

export type PostOrphanPolicy = 'park' | 'auto-retry'

export interface ConformanceAdapter {
  name: string
  profile: 'base' | 'full'
  createSession(options?: { sessionId?: string; mode?: AuthoringMode }): Operation<Session>
  simulateDeath?(sessionId: string): Operation<Session>
}
