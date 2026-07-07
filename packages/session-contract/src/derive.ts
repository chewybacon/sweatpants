import type {
  AnswerRecord,
  LogRecord,
  PendingWait,
  SessionStatus,
  TerminalRecord,
  WaitRecord,
} from './types.ts'
import { waitToken } from './token.ts'

export interface DerivedLogState {
  terminal?: TerminalRecord
  waits: Map<number, WaitRecord>
  answers: Map<number, AnswerRecord>
  fates: Map<number, Exclude<LogRecord, WaitRecord | AnswerRecord | TerminalRecord> & { kind: 'fate' }>
  idempotency: Map<string, LogRecord>
  queuedMessages: AnswerRecord[]
  consumedMessageCount: number
  pendingWaits: PendingWait[]
}

export function deriveLogState(sessionId: string, records: readonly LogRecord[]): DerivedLogState {
  const waits = new Map<number, WaitRecord>()
  const answers = new Map<number, AnswerRecord>()
  const fates = new Map<number, Extract<LogRecord, { kind: 'fate' }>>()
  const idempotency = new Map<string, LogRecord>()
  const messageAnswers: AnswerRecord[] = []
  let terminal: TerminalRecord | undefined

  for (const record of [...records].sort((a, b) => a.lsn - b.lsn)) {
    if (record.kind === 'wait') {
      waits.set(record.waitSeq, record)
    } else if (record.kind === 'answer') {
      idempotency.set(record.idempotencyKey, record)
      if (record.waitSeq !== undefined) {
        answers.set(record.waitSeq, record)
      } else {
        messageAnswers.push(record)
      }
    } else if (record.kind === 'fate') {
      fates.set(record.waitSeq, record)
    } else if (record.kind === 'terminal') {
      terminal = record
    }
  }

  const messageWaits = Array.from(waits.values())
    .filter((wait) => wait.wait === 'message')
    .sort((a, b) => a.waitSeq - b.waitSeq)
  let consumedMessageCount = 0
  for (const wait of messageWaits) {
    const message = messageAnswers[consumedMessageCount]
    if (message) {
      answers.set(wait.waitSeq, { ...message, waitSeq: wait.waitSeq, wait: 'message' })
      consumedMessageCount += 1
    }
  }

  const pendingWaits: PendingWait[] = []
  for (const wait of waits.values()) {
    if (answers.has(wait.waitSeq) || fates.has(wait.waitSeq)) {
      continue
    }
    pendingWaits.push({
      waitSeq: wait.waitSeq,
      token: waitToken(sessionId, wait.waitSeq),
      kind: wait.wait,
      ...(wait.expiresAt !== undefined ? { expiresAt: wait.expiresAt } : {}),
      payload: wait.payload,
    })
  }

  return {
    ...(terminal !== undefined ? { terminal } : {}),
    waits,
    answers,
    fates,
    idempotency,
    queuedMessages: messageAnswers.slice(consumedMessageCount),
    consumedMessageCount,
    pendingWaits,
  }
}

export function deriveStatus(sessionId: string, records: readonly LogRecord[]): SessionStatus {
  const state = deriveLogState(sessionId, records)
  if (state.terminal?.outcome === 'result') {
    return { state: 'completed', pendingWaits: [], terminal: { outcome: 'result', payload: state.terminal.payload } }
  }
  if (state.terminal?.outcome === 'error') {
    return { state: 'failed', pendingWaits: [], terminal: { outcome: 'error', payload: state.terminal.payload } }
  }
  if (state.terminal?.outcome === 'cancelled') {
    return { state: 'cancelled', pendingWaits: [], terminal: { outcome: 'cancelled', payload: state.terminal.payload } }
  }
  if (state.pendingWaits.length > 0) {
    return { state: 'parked', pendingWaits: state.pendingWaits }
  }
  return { state: 'running', pendingWaits: [] }
}

export function nextWaitSeq(records: readonly LogRecord[]): number {
  let max = 0
  for (const record of records) {
    if (record.kind === 'wait' && record.waitSeq > max) {
      max = record.waitSeq
    }
  }
  return max + 1
}
