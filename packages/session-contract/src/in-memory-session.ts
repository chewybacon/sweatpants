import { resource } from 'effection'
import type { Operation, Stream } from 'effection'

import type { TokenBuffer, TokenBufferStore } from '@sweatpants/durable-streams/types'
import { createInMemoryBufferStore } from '@sweatpants/durable-streams/in-memory-store'

import { usePostOrphanPolicy } from './contexts.ts'
import { deriveLogState, deriveStatus, nextWaitSeq } from './derive.ts'
import { mintEdgeIdempotencyKey, parseWaitToken } from './token.ts'
import {
  SessionContractError,
  type AnswerPayload,
  type AuthoringMode,
  type CheckpointRecord,
  type EmissionRecord,
  type FateRecord,
  type FoldSessionHost,
  type LogRecord,
  type MessageInput,
  type PostOrphanPolicy,
  type ResolutionMeta,
  type RespondAck,
  type RespondIfPendingResult,
  type SendAck,
  type TerminalRecord,
  type WaitKind,
  type WaitPayloadByKind,
  type WaitRecord,
} from './types.ts'

export type { TokenBuffer, TokenBufferStore }

export interface InMemorySession extends FoldSessionHost {}

export interface CreateInMemorySessionOptions {
  sessionId: string
  mode?: AuthoringMode
  bufferStore?: TokenBufferStore<LogRecord>
}

/**
 * Creates an in-memory `TokenBufferStore` for `LogRecord` values, backed by
 * `@sweatpants/durable-streams/in-memory-store`.
 *
 * Re-exported for convenience; consumers MAY also import
 * `createInMemoryBufferStore` directly from
 * `@sweatpants/durable-streams/in-memory-store`.
 */
export function createSessionContractInMemoryStore(): TokenBufferStore<LogRecord> {
  return createInMemoryBufferStore<LogRecord>()
}

export function* createInMemorySession(options: CreateInMemorySessionOptions): Operation<InMemorySession> {
  const mode = options.mode ?? 'fold'
  const bufferStore = options.bufferStore ?? createSessionContractInMemoryStore()
  let buffer = yield* bufferStore.get(options.sessionId)
  if (!buffer) {
    buffer = yield* bufferStore.create(options.sessionId)
  }
  return createSessionFromBuffer(options.sessionId, mode, buffer)
}

export function* restoreInMemorySession(
  options: CreateInMemorySessionOptions & { postOrphanPolicy?: PostOrphanPolicy },
): Operation<InMemorySession> {
  const session = yield* createInMemorySession(options)
  if ((options.mode ?? 'fold') === 'body') {
    yield* restoreBodySession(session, options.postOrphanPolicy ?? (yield* usePostOrphanPolicy()))
  }
  return session
}

function createSessionFromBuffer(id: string, mode: AuthoringMode, buffer: TokenBuffer<LogRecord>): InMemorySession {

  function* readRecords(): Operation<LogRecord[]> {
    const result = yield* buffer.read(0)
    return result.tokens
  }

  function* appendRecord<T extends LogRecord>(record: Omit<T, 'lsn'>): Operation<T> {
    const records = yield* readRecords()
    if (records.some((candidate) => candidate.kind === 'terminal')) {
      throw new SessionContractError('terminal_session', 'Cannot append after terminal')
    }
    const nextLsn = records.length + 1
    const withLsn = { ...record, lsn: nextLsn } as T
    try {
      yield* buffer.append([withLsn])
    } catch (error) {
      // REQ-061: the durable-streams buffer throws 'Buffer is closed' after
      // complete() or fail(). Map this to the session-contract error code.
      throw new SessionContractError('terminal_session', 'Cannot append after terminal', { cause: error })
    }
    return withLsn
  }

  function* appendFate(waitSeq: number, fate: FateRecord['fate'], reason?: string): Operation<FateRecord> {
    const state = deriveLogState(id, yield* readRecords())
    if (!state.waits.has(waitSeq)) {
      throw new SessionContractError('unknown_wait', `Unknown wait ${waitSeq}`)
    }
    if (state.answers.has(waitSeq) || state.fates.has(waitSeq)) {
      throw new SessionContractError('resume_unavailable', `Wait ${waitSeq} is not pending`)
    }
    const record: Omit<FateRecord, 'lsn'> = {
      kind: 'fate',
      waitSeq,
      fate,
      ...(reason !== undefined ? { reason } : {}),
    }
    return yield* appendRecord<FateRecord>(record)
  }

  function* respondCore(
    waitTokenString: string,
    payload: unknown,
    opts: { idempotencyKey?: string; wait?: WaitKind; resolution?: ResolutionMeta } | undefined,
    mode: 'throw' | 'ifPending',
  ): Operation<RespondAck | RespondIfPendingResult> {
    const parsed = parseWaitToken(waitTokenString)
    if (parsed.sessionId !== id) {
      if (mode === 'ifPending') {
        return { type: 'not_pending', waitSeq: parsed.waitSeq, reason: 'unknown' }
      }
      throw new SessionContractError('unknown_wait', 'Wait token belongs to another session')
    }

    const records = yield* readRecords()
    const state = deriveLogState(id, records)
    const idempotencyKey = opts?.idempotencyKey ?? mintEdgeIdempotencyKey(id)
    const answerPayload = normalizeAnswerPayload(payload)
    const existing = state.idempotency.get(idempotencyKey)
    if (existing) {
      if (
        existing.kind === 'answer' &&
        existing.waitSeq === parsed.waitSeq &&
        sameValue(existing.payload, answerPayload)
      ) {
        const ack = { lsn: existing.lsn, waitSeq: parsed.waitSeq, idempotencyKey }
        return mode === 'ifPending' ? { type: 'accepted', ack } : ack
      }
      throw new SessionContractError('idempotency_conflict', 'Duplicate idempotency key with different payload')
    }

    if (state.terminal) {
      if (mode === 'ifPending') {
        return {
          type: 'terminal',
          waitSeq: parsed.waitSeq,
          outcome: state.terminal.outcome,
          ...(state.terminal.payload !== undefined ? { payload: state.terminal.payload } : {}),
        }
      }
    }

    const wait = state.waits.get(parsed.waitSeq)
    if (!wait) {
      if (mode === 'ifPending') {
        return { type: 'not_pending', waitSeq: parsed.waitSeq, reason: 'unknown' }
      }
      throw new SessionContractError('unknown_wait', `Unknown wait ${parsed.waitSeq}`)
    }
    if (state.answers.has(parsed.waitSeq)) {
      if (mode === 'ifPending') {
        return { type: 'not_pending', waitSeq: parsed.waitSeq, reason: 'answered' }
      }
      throw new SessionContractError('resume_unavailable', `Wait ${parsed.waitSeq} is not pending`)
    }
    if (state.fates.has(parsed.waitSeq)) {
      if (mode === 'ifPending') {
        return { type: 'not_pending', waitSeq: parsed.waitSeq, reason: 'fated' }
      }
      throw new SessionContractError('resume_unavailable', `Wait ${parsed.waitSeq} is not pending`)
    }
    if (isExpired(wait.expiresAt)) {
      yield* appendFate(parsed.waitSeq, 'expired', 'expiresAt')
      if (mode === 'ifPending') {
        return { type: 'not_pending', waitSeq: parsed.waitSeq, reason: 'expired' }
      }
      throw new SessionContractError('resume_unavailable', `Wait ${parsed.waitSeq} expired`)
    }
    if (opts?.wait !== undefined && opts.wait !== wait.wait) {
      throw new SessionContractError('wait_kind_mismatch', `Expected ${wait.wait}, got ${opts.wait}`)
    }

    const answerRecord: Omit<LogRecord & { kind: 'answer' }, 'lsn'> = {
      kind: 'answer',
      waitSeq: parsed.waitSeq,
      wait: wait.wait,
      payload: answerPayload,
      idempotencyKey,
      ...(opts?.resolution !== undefined ? { resolution: opts.resolution } : {}),
    }

    try {
      const record = yield* appendRecord<LogRecord & { kind: 'answer' }>(answerRecord)
      const ack = { lsn: record.lsn, waitSeq: parsed.waitSeq, idempotencyKey }
      return mode === 'ifPending' ? { type: 'accepted', ack } : ack
    } catch (error) {
      if (mode === 'ifPending' && error instanceof SessionContractError && error.code === 'terminal_session') {
        const terminal = deriveLogState(id, yield* readRecords()).terminal
        return {
          type: 'terminal',
          waitSeq: parsed.waitSeq,
          outcome: terminal?.outcome ?? 'error',
          ...(terminal?.payload !== undefined ? { payload: terminal.payload } : {}),
        }
      }
      throw error
    }
  }

  const session: InMemorySession = {
    id,
    events(afterLSN = 0): Stream<LogRecord, void> {
      return resource(function* (provide) {
        let cursor = afterLSN
        yield* provide({
          *next(): Operation<IteratorResult<LogRecord, void>> {
            while (true) {
              const { tokens } = yield* buffer.read(cursor)
              if (tokens.length > 0) {
                const record = tokens[0]!
                cursor = record.lsn
                return { done: false, value: record }
              }
              if (yield* buffer.isComplete()) {
                return { done: true, value: undefined }
              }
              const error = yield* buffer.getError()
              if (error) {
                // REQ-061: buffer fail() maps to session_lost. We cannot
                // append a terminal record to a failed buffer, so we throw
                // the substrate error. The status() surface derives the
                // session_lost state from the buffer error.
                throw new SessionContractError('session_lost', error.message, { cause: error })
              }
              yield* buffer.waitForChange(cursor)
            }
          },
        })
      })
    },
    *send(message: MessageInput, opts?: { idempotencyKey?: string }): Operation<SendAck> {
      if (mode === 'body') {
        throw new SessionContractError('unsupported_operation', 'send() is not supported on body-mode sessions')
      }
      const records = yield* readRecords()
      const state = deriveLogState(id, records)
      if (state.terminal) {
        throw new SessionContractError('terminal_session', 'Cannot send to terminal session')
      }
      const idempotencyKey = opts?.idempotencyKey ?? mintEdgeIdempotencyKey(id)
      const existing = state.idempotency.get(idempotencyKey)
      const payload: AnswerPayload = { ok: true, value: message }
      if (existing) {
        if (
          existing.kind === 'answer' &&
          existing.wait === 'message' &&
          existing.waitSeq === undefined &&
          sameValue(existing.payload, payload)
        ) {
          return { lsn: existing.lsn, idempotencyKey }
        }
        throw new SessionContractError('idempotency_conflict', 'Duplicate idempotency key with different payload')
      }
      const record = yield* appendRecord<LogRecord & { kind: 'answer' }>({
        kind: 'answer',
        wait: 'message',
        payload,
        idempotencyKey,
      })
      return { lsn: record.lsn, idempotencyKey }
    },
    *respond(waitToken: string, payload: unknown, opts?: { idempotencyKey?: string; wait?: WaitKind; resolution?: ResolutionMeta }): Operation<RespondAck> {
      return (yield* respondCore(waitToken, payload, opts, 'throw')) as RespondAck
    },
    *respondIfPending(waitToken: string, payload: unknown, opts?: { idempotencyKey?: string; wait?: WaitKind; resolution?: ResolutionMeta }): Operation<RespondIfPendingResult> {
      return (yield* respondCore(waitToken, payload, opts, 'ifPending')) as RespondIfPendingResult
    },
    *cancel(reason?: string): Operation<void> {
      const state = deriveLogState(id, yield* readRecords())
      if (state.terminal) {
        return
      }
      for (const pending of state.pendingWaits) {
        yield* appendFate(pending.waitSeq, 'cancelled', reason)
      }
      yield* appendRecord<TerminalRecord>({
        kind: 'terminal',
        outcome: 'cancelled',
        ...(reason !== undefined ? { payload: { reason } } : {}),
      })
      yield* buffer.complete()
    },
    *status() {
      // REQ-061: if the buffer has a substrate error (fail()), derive a
      // session_lost terminal state even if no terminal record was appended
      // (a failed buffer rejects further appends).
      const bufferError = yield* buffer.getError()
      if (bufferError) {
        return {
          state: 'failed' as const,
          pendingWaits: [],
          terminal: { outcome: 'error' as const, payload: { ok: false, code: 'session_lost', message: bufferError.message } },
        }
      }
      return deriveStatus(id, yield* readRecords())
    },
    *emitWait<K extends WaitKind>(wait: K, payload: WaitPayloadByKind[K], waitOptions?: { expiresAt?: string }): Operation<WaitRecord<K>> {
      const waitSeq = nextWaitSeq(yield* readRecords())
      const record: Omit<WaitRecord<K>, 'lsn'> = {
        kind: 'wait',
        waitSeq,
        wait,
        payload,
        ...(waitOptions?.expiresAt !== undefined ? { expiresAt: waitOptions.expiresAt } : {}),
      }
      return yield* appendRecord<WaitRecord<K>>(record)
    },
    *emitEmission(payload: unknown): Operation<EmissionRecord> {
      return yield* appendRecord<EmissionRecord>({ kind: 'emission', payload })
    },
    *checkpoint(checkpointMode: AuthoringMode = mode, state?: unknown): Operation<CheckpointRecord> {
      const record: Omit<CheckpointRecord, 'lsn'> = {
        kind: 'checkpoint',
        mode: checkpointMode,
        waitSeqWatermark: nextWaitSeq(yield* readRecords()) - 1,
        ...(state !== undefined ? { state } : {}),
      }
      return yield* appendRecord<CheckpointRecord>(record)
    },
    *terminal(outcome: TerminalRecord['outcome'], payload?: unknown): Operation<TerminalRecord> {
      const record: Omit<TerminalRecord, 'lsn'> = {
        kind: 'terminal',
        outcome,
        ...(payload !== undefined ? { payload } : {}),
      }
      const terminal = yield* appendRecord<TerminalRecord>(record)
      yield* buffer.complete()
      return terminal
    },
    *expire(waitSeq: number, reason?: string): Operation<FateRecord> {
      return yield* appendFate(waitSeq, 'expired', reason)
    },
    *orphan(waitSeq: number, reason?: string): Operation<FateRecord> {
      return yield* appendFate(waitSeq, 'orphaned', reason)
    },
    records: readRecords,
  }

  return session
}

function* restoreBodySession(
  session: InMemorySession,
  postOrphanPolicy: PostOrphanPolicy,
): Operation<void> {
  const records = yield* session.records()
  if (records.some((record) => record.kind === 'terminal')) {
    return
  }

  const checkpoints = records.filter(
    (record): record is CheckpointRecord => record.kind === 'checkpoint' && record.mode === 'body',
  )
  const watermark = checkpoints.at(-1)?.waitSeqWatermark ?? 0
  const state = deriveLogState(session.id, records)
  const orphanable = Array.from(state.waits.values())
    .filter((wait) => wait.waitSeq > watermark)
    .filter((wait) => !state.answers.has(wait.waitSeq) && !state.fates.has(wait.waitSeq))

  for (const wait of orphanable) {
    yield* session.orphan(wait.waitSeq, 'restore')
  }

  const restoredStatus = yield* session.status()
  if (postOrphanPolicy === 'park' && restoredStatus.state === 'running') {
    yield* session.emitWait('message', { prompt: 'resume' })
  }
}

function normalizeAnswerPayload(payload: unknown): AnswerPayload {
  if (isAnswerPayload(payload)) {
    return payload
  }
  return { ok: true, value: payload }
}

function isAnswerPayload(payload: unknown): payload is AnswerPayload {
  return Boolean(
    payload &&
      typeof payload === 'object' &&
      'ok' in payload &&
      typeof (payload as { ok?: unknown }).ok === 'boolean',
  )
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function isExpired(expiresAt: string | undefined): boolean {
  return expiresAt !== undefined && Date.parse(expiresAt) <= Date.now()
}
