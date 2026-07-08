import { run } from 'effection'
import { describe, expect, it } from 'vitest'

import {
  createInMemorySession,
  createSessionContractInMemoryStore,
  validateLog,
  waitToken,
  type InMemorySession,
  type LogRecord,
  type SessionErrorCode,
} from '../index.ts'

function* expectSessionError(
  operation: Generator<unknown, unknown, unknown>,
  code: SessionErrorCode | (string & {}),
): Generator<unknown, void, unknown> {
  try {
    yield* operation
    throw new Error(`expected ${code}`)
  } catch (error) {
    expect(error).toMatchObject({ code })
  }
}

function expectStrictlyIncreasingLsns(records: LogRecord[]): void {
  for (let index = 0; index < records.length; index += 1) {
    expect(records[index]?.lsn).toBe(index + 1)
  }
}

describe('@sweatpants/session-contract core hardening', () => {
  it('answers a wait idempotently with the same key and payload', async () => {
    await run(function* () {
      const session = yield* createInMemorySession({ sessionId: 'core-idempotent-respond' })
      const wait = yield* session.emitWait('elicit', {
        key: 'confirm',
        message: 'Confirm?',
        responseSchema: { type: 'boolean' },
      })
      const token = waitToken(session.id, wait.waitSeq)

      const first = yield* session.respond(token, true, { idempotencyKey: 'answer:1', wait: 'elicit' })
      const replay = yield* session.respond(token, true, { idempotencyKey: 'answer:1', wait: 'elicit' })

      expect(replay).toEqual(first)
      expect((yield* session.status()).pendingWaits).toEqual([])
      expect((yield* session.records()).filter((record) => record.kind === 'answer')).toHaveLength(1)
    })
  })

  it('reports lifecycle races through respondIfPending without throwing', async () => {
    await run(function* () {
      const session = yield* createInMemorySession({ sessionId: 'core-respond-if-pending' })
      const wait = yield* session.emitWait('elicit', {
        key: 'confirm',
        message: 'Confirm?',
        responseSchema: {},
      })
      const token = waitToken(session.id, wait.waitSeq)

      const accepted = yield* session.respondIfPending(token, true, {
        idempotencyKey: 'if-pending-answer',
        wait: 'elicit',
      })
      expect(accepted).toMatchObject({ type: 'accepted', ack: { waitSeq: wait.waitSeq } })

      const answered = yield* session.respondIfPending(token, true, {
        idempotencyKey: 'if-pending-second-key',
        wait: 'elicit',
      })
      expect(answered).toEqual({ type: 'not_pending', waitSeq: wait.waitSeq, reason: 'answered' })

      const unknown = yield* session.respondIfPending(waitToken(session.id, wait.waitSeq + 1), true, { wait: 'elicit' })
      expect(unknown).toEqual({ type: 'not_pending', waitSeq: wait.waitSeq + 1, reason: 'unknown' })

      const terminal = yield* createInMemorySession({ sessionId: 'core-respond-if-pending-terminal' })
      const terminalWait = yield* terminal.emitWait('sample', { messages: [] })
      yield* terminal.terminal('cancelled', { reason: 'user' })
      const terminalResult = yield* terminal.respondIfPending(waitToken(terminal.id, terminalWait.waitSeq), { ok: true }, { wait: 'sample' })
      expect(terminalResult).toEqual({
        type: 'terminal',
        waitSeq: terminalWait.waitSeq,
        outcome: 'cancelled',
        payload: { reason: 'user' },
      })
    })
  })

  it('rejects duplicate wait answers with conflicting idempotency or a new answer key', async () => {
    await run(function* () {
      const session = yield* createInMemorySession({ sessionId: 'core-conflicting-respond' })
      const wait = yield* session.emitWait('elicit', {
        key: 'confirm',
        message: 'Confirm?',
        responseSchema: { type: 'boolean' },
      })
      const token = waitToken(session.id, wait.waitSeq)

      yield* session.respond(token, true, { idempotencyKey: 'answer:1', wait: 'elicit' })

      yield* expectSessionError(
        session.respond(token, false, { idempotencyKey: 'answer:1', wait: 'elicit' }),
        'idempotency_conflict',
      )
      yield* expectSessionError(
        session.respond(token, true, { idempotencyKey: 'answer:2', wait: 'elicit' }),
        'resume_unavailable',
      )
    })
  })

  it('rejects unknown waits, wrong-session tokens, and wait kind mismatches deterministically', async () => {
    await run(function* () {
      const session = yield* createInMemorySession({ sessionId: 'core-bad-waits' })
      const wait = yield* session.emitWait('sample', { messages: [] })

      yield* expectSessionError(
        session.respond(waitToken(session.id, wait.waitSeq + 1), { text: 'late' }, { wait: 'sample' }),
        'unknown_wait',
      )
      yield* expectSessionError(
        session.respond(waitToken('another-session', wait.waitSeq), { text: 'wrong owner' }, { wait: 'sample' }),
        'unknown_wait',
      )
      yield* expectSessionError(
        session.respond(waitToken(session.id, wait.waitSeq), { text: 'wrong kind' }, { wait: 'elicit' }),
        'wait_kind_mismatch',
      )
    })
  })

  it('reports multiple pending waits and removes each wait from status after answer', async () => {
    await run(function* () {
      const session = yield* createInMemorySession({ sessionId: 'core-multiple-pending' })
      const first = yield* session.emitWait('call', { target: 'alpha', input: { a: 1 } })
      const second = yield* session.emitWait('call', { target: 'beta', input: { b: 2 } })

      let status = yield* session.status()
      expect(status.state).toBe('parked')
      expect(status.pendingWaits.map((wait) => wait.waitSeq)).toEqual([first.waitSeq, second.waitSeq])
      expect(status.pendingWaits.every((wait) => wait.kind === 'call')).toBe(true)

      yield* session.respond(waitToken(session.id, first.waitSeq), { ok: true, value: 'a' }, {
        idempotencyKey: 'call:first',
        wait: 'call',
      })
      status = yield* session.status()
      expect(status.pendingWaits.map((wait) => wait.waitSeq)).toEqual([second.waitSeq])

      yield* session.respond(waitToken(session.id, second.waitSeq), { ok: true, value: 'b' }, {
        idempotencyKey: 'call:second',
        wait: 'call',
      })
      status = yield* session.status()
      expect(status.state).toBe('running')
      expect(status.pendingWaits).toEqual([])
    })
  })

  it('lets terminal state win over otherwise-pending waits and rejects terminal mutations', async () => {
    await run(function* () {
      const session = yield* createInMemorySession({ sessionId: 'core-terminal-wins' })
      const wait = yield* session.emitWait('elicit', {
        key: 'confirm',
        message: 'Confirm?',
        responseSchema: {},
      })
      yield* session.terminal('result', { done: true })

      const status = yield* session.status()
      expect(status.state).toBe('completed')
      expect(status.pendingWaits).toEqual([])
      expect(status.terminal).toMatchObject({ outcome: 'result', payload: { done: true } })

      yield* expectSessionError(
        session.send({ role: 'user', content: 'late' }, { idempotencyKey: 'late-message' }),
        'terminal_session',
      )
      yield* expectSessionError(
        session.respond(waitToken(session.id, wait.waitSeq), true, { idempotencyKey: 'late-answer', wait: 'elicit' }),
        'terminal_session',
      )
      yield* expectSessionError(session.emitEmission({ late: true }), 'terminal_session')
    })
  })

  it('rejects body-mode send and rejects further progress after cancellation', async () => {
    await run(function* () {
      const body = yield* createInMemorySession({ sessionId: 'core-body-send', mode: 'body' })
      yield* expectSessionError(
        body.send({ role: 'user', content: 'not supported' }, { idempotencyKey: 'body-send' }),
        'unsupported_operation',
      )

      const session = yield* createInMemorySession({ sessionId: 'core-cancel-mutability' })
      const wait = yield* session.emitWait('elicit', {
        key: 'confirm',
        message: 'Confirm?',
        responseSchema: {},
      })
      yield* session.cancel('user')
      expect((yield* session.status()).state).toBe('cancelled')

      yield* expectSessionError(
        session.send({ role: 'user', content: 'after cancel' }, { idempotencyKey: 'after-cancel' }),
        'terminal_session',
      )
      yield* expectSessionError(
        session.respond(waitToken(session.id, wait.waitSeq), true, { idempotencyKey: 'cancel-answer', wait: 'elicit' }),
        'resume_unavailable',
      )
      yield* expectSessionError(session.emitWait('sample', { messages: [] }), 'terminal_session')
    })
  })

  it('reconstructs pending waits, answered waits, terminal state, and checkpoints after reopen', async () => {
    await run(function* () {
      const bufferStore = createSessionContractInMemoryStore()
      const session = yield* createInMemorySession({ sessionId: 'core-reopen', bufferStore })
      const pending = yield* session.emitWait('elicit', {
        key: 'pending',
        message: 'Still pending?',
        responseSchema: {},
      })
      const answered = yield* session.emitWait('sample', { messages: [{ role: 'user', content: 'hello' }] })
      yield* session.respond(waitToken(session.id, answered.waitSeq), { ok: true, value: 'sampled' }, {
        idempotencyKey: 'sample-answer',
        wait: 'sample',
      })
      const checkpoint = yield* session.checkpoint('fold', { step: 'safe' })

      const reopened = yield* createInMemorySession({ sessionId: 'core-reopen', bufferStore })
      const reopenedStatus = yield* reopened.status()
      expect(reopenedStatus.state).toBe('parked')
      expect(reopenedStatus.pendingWaits.map((wait) => wait.waitSeq)).toEqual([pending.waitSeq])
      expect(reopenedStatus.pendingWaits[0]?.token).toBe(waitToken(session.id, pending.waitSeq))
      expect(reopenedStatus.pendingWaits.some((wait) => wait.waitSeq === answered.waitSeq)).toBe(false)
      expect((yield* reopened.records()).at(-1)).toEqual(checkpoint)

      yield* reopened.terminal('error', { code: 'boom' })
      const reopenedTerminal = yield* createInMemorySession({ sessionId: 'core-reopen', bufferStore })
      expect((yield* reopenedTerminal.status())).toMatchObject({
        state: 'failed',
        terminal: { outcome: 'error', payload: { code: 'boom' } },
        pendingWaits: [],
      })
    })
  })

  it('preserves LSN ordering and never records an answer before its wait', async () => {
    await run(function* () {
      const session = yield* createInMemorySession({ sessionId: 'core-lsn-order' })
      const first = yield* session.emitWait('call', { target: 'first', input: {} })
      const second = yield* session.emitWait('call', { target: 'second', input: {} })
      yield* session.respond(waitToken(session.id, second.waitSeq), { ok: true, value: 'second' }, {
        idempotencyKey: 'answer-second',
        wait: 'call',
      })
      yield* session.respond(waitToken(session.id, first.waitSeq), { ok: true, value: 'first' }, {
        idempotencyKey: 'answer-first',
        wait: 'call',
      })
      yield* session.checkpoint('fold')

      const records = yield* session.records()
      expectStrictlyIncreasingLsns(records)
      validateLog(records)

      const waitsBySeq = new Map<number, number>()
      for (const record of records) {
        if (record.kind === 'wait') waitsBySeq.set(record.waitSeq, record.lsn)
        if (record.kind === 'answer' && record.waitSeq !== undefined) {
          expect(waitsBySeq.get(record.waitSeq)).toBeLessThan(record.lsn)
        }
      }
      expect(records.filter((record) => record.kind === 'wait').map((record) => record.lsn)).toEqual([1, 2])
      expect(records.filter((record) => record.kind === 'answer').map((record) => record.lsn)).toEqual([3, 4])
    })
  })

  it('closes completed event streams after terminal records while retaining history for replay', async () => {
    await run(function* () {
      const bufferStore = createSessionContractInMemoryStore()
      const session = yield* createInMemorySession({ sessionId: 'core-terminal-events', bufferStore })
      yield* session.emitEmission({ chunk: 'before-terminal' })
      yield* session.terminal('result', { ok: true })

      const replay = yield* session.events()
      expect((yield* replay.next()).value).toMatchObject({ lsn: 1, kind: 'emission' })
      expect((yield* replay.next()).value).toMatchObject({ lsn: 2, kind: 'terminal' })
      expect((yield* replay.next()).done).toBe(true)

      const afterTerminal = yield* createInMemorySession({ sessionId: 'core-terminal-events', bufferStore })
      expect((yield* afterTerminal.status()).state).toBe('completed')
    })
  })
})
