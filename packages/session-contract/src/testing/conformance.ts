import type { Operation, Subscription } from 'effection'

import { validateLog } from '../validator.ts'
import type { LogRecord, Session, WaitKind } from '../types.ts'

export interface BaseProfileConformanceAdapter {
  name: string
  createElicitSession(sessionId: string): Operation<Session>
  elicitPayload: unknown
  createSampleSession?: (sessionId: string) => Operation<Session>
  samplePayload?: unknown
}

export interface BaseProfileConformanceResult {
  name: string
  scenarios: Array<'elicit' | 'sample'>
}

export function* runBaseProfileConformance(
  adapter: BaseProfileConformanceAdapter,
): Operation<BaseProfileConformanceResult> {
  const scenarios: Array<'elicit' | 'sample'> = []
  yield* exerciseWaitScenario(adapter.createElicitSession, 'elicit', adapter.elicitPayload, `${adapter.name}-elicit`)
  scenarios.push('elicit')

  if (adapter.createSampleSession && adapter.samplePayload !== undefined) {
    yield* exerciseWaitScenario(adapter.createSampleSession, 'sample', adapter.samplePayload, `${adapter.name}-sample`)
    scenarios.push('sample')
  }

  return { name: adapter.name, scenarios }
}

function* exerciseWaitScenario(
  createSession: (sessionId: string) => Operation<Session>,
  kind: Extract<WaitKind, 'elicit' | 'sample'>,
  payload: unknown,
  sessionId: string,
): Operation<void> {
  const session = yield* createSession(sessionId)
  try {
    yield* session.send({ role: 'user', content: 'unsupported' })
    throw new Error(`${kind} base-profile session unexpectedly accepted send()`)
  } catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error)) {
      throw error
    }
  }

  const events = yield* session.events()
  const wait = yield* nextRecord(events, (record): record is Extract<LogRecord, { kind: 'wait' }> => record.kind === 'wait')
  if (wait.wait !== kind) {
    throw new Error(`Expected ${kind} wait, got ${wait.wait}`)
  }

  const pending = yield* session.status()
  const pendingWait = pending.pendingWaits[0]
  if (!pendingWait || pendingWait.kind !== kind) {
    throw new Error(`Expected pending ${kind} wait in status()`)
  }

  yield* session.respond(pendingWait.token, payload, {
    idempotencyKey: `${sessionId}:answer`,
    wait: kind,
  })

  try {
    yield* session.respond(pendingWait.token, payload, {
      idempotencyKey: `${sessionId}:second-answer`,
      wait: kind,
    })
    throw new Error(`Expected second ${kind} respond() to fail`)
  } catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && (error as { code: string }).code === 'resume_unavailable')) {
      throw error
    }
  }

  const records = [wait] as LogRecord[]
  let next = yield* events.next()
  while (!next.done) {
    records.push(next.value)
    if (next.value.kind === 'terminal') {
      break
    }
    next = yield* events.next()
  }
  validateLog(records)
}

function* nextRecord<TRecord extends LogRecord>(
  events: Subscription<LogRecord, void>,
  predicate: (record: LogRecord) => record is TRecord,
): Operation<TRecord> {
  let next = yield* events.next()
  while (!next.done) {
    if (predicate(next.value)) {
      return next.value
    }
    next = yield* events.next()
  }
  throw new Error('Expected matching record before stream completion')
}
