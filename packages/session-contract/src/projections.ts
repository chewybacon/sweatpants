import type { LogRecord, PendingWait, AnswerRecord, CheckpointRecord, WaitRecord, TerminalRecord, EmissionRecord, FateRecord, SessionStatus } from './types.ts'

/** Projection-layer reference vocabulary salvaged from the retired agents sketch. */
export type ProjectionCommand =
  | { type: 'sendMessage'; message: string; contextId?: string; messageId?: string }
  | { type: 'respondWait'; waitToken: string; payload: unknown }
  | { type: 'cancel'; reason?: string }

export interface AGUIInterrupt {
  interruptId: string
  id: string
  reason: string
  message: string
  responseSchema?: unknown
  expiresAt?: string
  metadata: {
    sweatpants: {
      token: string
      waitSeq: number
      kind: string
    }
    [key: string]: unknown
  }
}

export type AGUIResume =
  | { interruptId: string; status: 'resolved'; payload: unknown }
  | { interruptId: string; status: 'cancelled'; payload?: unknown }

export function waitToAGUIInterrupt(wait: PendingWait): AGUIInterrupt {
  const payload = wait.payload as { message?: string; responseSchema?: unknown }
  return {
    interruptId: wait.token,
    id: wait.token,
    reason: wait.kind,
    message: payload.message ?? wait.kind,
    ...(payload.responseSchema !== undefined ? { responseSchema: payload.responseSchema } : {}),
    ...(wait.expiresAt !== undefined ? { expiresAt: wait.expiresAt } : {}),
    metadata: {
      sweatpants: {
        token: wait.token,
        waitSeq: wait.waitSeq,
        kind: wait.kind,
      },
    },
  }
}

export type TaskState = 'input-required' | 'cancelled' | 'completed' | 'failed'

export function waitToTaskState(wait: PendingWait): { state: TaskState; waitToken: string; kind: string } {
  return { state: 'input-required', waitToken: wait.token, kind: wait.kind }
}

// =============================================================================
// WIRE PROJECTION (REQ-074, REQ-080, REQ-082)
// =============================================================================

/**
 * Context passed to wire projection functions. Derived from `deriveLogState()`,
 * NOT stored. This keeps projections stateless and testable.
 */
export interface ProjectionContext {
  /** Current turn sequence number (0-indexed). */
  turnSeq: number
  /** Number of pending `call` waits in the current turn. */
  pendingCallCount: number
  /** Whether the client is authorized to see system prompts. */
  authorized: boolean
}

/**
 * A wire event is the output of a projection. It is protocol-agnostic here;
 * protocol-specific projections (AG-UI, MCP) map to their own event shapes.
 */
export type WireEvent = { type: string; [key: string]: unknown }

/**
 * Sanitizes a `LogRecord` for wire transmission (REQ-080).
 *
 * Strips:
 * - `checkpoint.state` (serialized author/body-mode state)
 * - `answer.resolution` (provider, childSessionId, timing)
 * - `sample` wait payload `options.system` (system prompts) unless authorized
 *
 * This is a PURE function — same input always produces the same output.
 */
export function sanitizeRecord(record: LogRecord, authorized = false): LogRecord {
  switch (record.kind) {
    case 'checkpoint': {
      // Strip checkpoint.state
      const { state: _state, ...rest } = record as CheckpointRecord
      return rest as LogRecord
    }
    case 'answer': {
      // Strip answer.resolution
      const { resolution: _resolution, ...rest } = record as AnswerRecord
      return rest as LogRecord
    }
    case 'wait': {
      const waitRec = record as WaitRecord
      if (waitRec.wait === 'sample') {
        const payload = waitRec.payload as { messages: unknown[]; options?: Record<string, unknown> }
        if (payload.options && !authorized) {
          // Strip system prompt from sample options
          const { system: _system, ...restOptions } = payload.options
          return {
            ...waitRec,
            payload: { ...payload, options: restOptions } as unknown as LogRecord,
          } as LogRecord
        }
      }
      return record
    }
    default:
      return record
  }
}

/**
 * Projects a `LogRecord` to wire events (REQ-074).
 *
 * This is a PURE function: `(LogRecord, ProjectionContext) → WireEvent[]`.
 * No state, no side effects. The projection is testable in isolation without
 * a running server.
 *
 * The record should be sanitized (via `sanitizeRecord`) before projection.
 */
export function projectLogRecord(record: LogRecord, context: ProjectionContext): WireEvent[] {
  switch (record.kind) {
    case 'wait': {
      const wait = record as WaitRecord
      if (wait.wait === 'elicit') {
        const payload = wait.payload as { message?: string; responseSchema?: unknown; key?: string }
        return [{
          type: 'RUN_FINISHED',
          interrupt: {
            interruptId: `wait:${wait.waitSeq}`,
            id: wait.waitSeq,
            reason: 'elicit',
            message: payload.message ?? 'elicit',
            ...(payload.responseSchema !== undefined ? { responseSchema: payload.responseSchema } : {}),
          },
        }]
      }
      if (wait.wait === 'message') {
        return [{ type: 'TURN_BOUNDARY', turnSeq: context.turnSeq }]
      }
      // sample and call waits are internal — no wire event
      return []
    }
    case 'answer': {
      const answer = record as AnswerRecord
      if (answer.wait === 'elicit') {
        return [{ type: 'RUN_RESUMED', interruptId: answer.waitSeq !== undefined ? `wait:${answer.waitSeq}` : undefined }]
      }
      // message, sample, call answers are internal — no wire event
      return []
    }
    case 'emission': {
      const emission = record as EmissionRecord
      const payload = emission.payload as { type?: string; [key: string]: unknown }
      if (payload?.type === 'text_delta') {
        return [{ type: 'TEXT_MESSAGE_CONTENT', delta: payload['delta'] ?? '', lsn: record.lsn }]
      }
      if (payload?.type === 'text_start') {
        return [{ type: 'TEXT_MESSAGE_START', lsn: record.lsn }]
      }
      if (payload?.type === 'text_end') {
        return [{ type: 'TEXT_MESSAGE_DONE', lsn: record.lsn }]
      }
      // Generic emission → notification
      return [{ type: 'EMISSION', payload: emission.payload, lsn: record.lsn }]
    }
    case 'checkpoint': {
      return [{ type: 'CHECKPOINT', mode: (record as CheckpointRecord).mode, lsn: record.lsn }]
    }
    case 'terminal': {
      const terminal = record as TerminalRecord
      return [{
        type: 'RUN_FINISHED',
        outcome: terminal.outcome,
        ...(terminal.payload !== undefined ? { payload: terminal.payload } : {}),
        lsn: record.lsn,
      }]
    }
    case 'fate': {
      const fate = record as FateRecord
      return [{
        type: 'FATE',
        waitSeq: fate.waitSeq,
        fate: fate.fate,
        ...(fate.reason !== undefined ? { reason: fate.reason } : {}),
        lsn: record.lsn,
      }]
    }
    default:
      return []
  }
}

/**
 * Projects a `SessionStatus` to a wire event (REQ-082).
 */
export function projectStatus(status: SessionStatus, _context: ProjectionContext): WireEvent {
  if (status.terminal) {
    return { type: 'RUN_FINISHED', outcome: status.terminal.outcome, ...(status.terminal.payload !== undefined ? { payload: status.terminal.payload } : {}) }
  }
  if (status.state === 'parked' && status.pendingWaits.length > 0) {
    const wait = status.pendingWaits[0]!
    if (wait.kind === 'elicit') {
      return { type: 'RUN_FINISHED', interrupt: waitToAGUIInterrupt(wait) }
    }
  }
  return { type: 'STATUS', state: status.state }
}
