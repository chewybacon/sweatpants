import { run, type Operation, type Subscription } from 'effection'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createTool } from '@sweatpants/core'
import { adaptToolSessionToSessionContract, type ToolSessionSamplingProvider } from '@sweatpants/framework/chat/mcp-tools'
import type { LogRecord, Session } from '@sweatpants/session-contract'

import { createToolSession } from '../src/index.ts'

const samplingProvider: ToolSessionSamplingProvider = {
  *sample() {
    return { text: 'unused' }
  },
}

const ElicitTool = createTool('session_contract_local_elicit')
  .description('Emits an elicit and returns the accepted payload')
  .parameters(z.object({}))
  .elicits({ confirm: z.object({ confirmed: z.boolean() }) })
  .execute(function* (_params, ctx) {
    const result = yield* ctx.elicit('confirm', { message: 'Confirm?' })
    if (result.action !== 'accept') {
      return { confirmed: false }
    }
    return { confirmed: result.content.confirmed }
  })

const SampleTool = createTool('session_contract_local_sample')
  .description('Emits a sample request and returns the sampled text')
  .parameters(z.object({}))
  .samples()
  .execute(function* (_params, ctx) {
    const result = yield* ctx.sample({ prompt: 'classify' })
    return { text: result.text }
  })

describe('@sweatpants/tool-runtime-local session-contract adapter', () => {
  it('projects local elicitation sessions into the base session contract', async () => {
    await run(function* () {
      const toolSession = yield* createToolSession(ElicitTool, {}, samplingProvider, {
        sessionId: 'local-contract-elicit',
      })
      const session = yield* adaptToolSessionToSessionContract(toolSession)
      const events = yield* session.events()

      const wait = yield* nextWait(events)
      expect(wait.wait).toBe('elicit')
      expect(wait.waitSeq).toBe(1)

      const pending = yield* expectOnePendingWait(session, 'elicit')
      expect(pending.waitSeq).toBe(1)

      yield* assertUnsupportedSend(session)

      const ack = yield* session.respond(pending.token, { confirmed: true }, {
        idempotencyKey: 'local-elicit-answer',
        wait: 'elicit',
      })
      expect(ack.waitSeq).toBe(1)

      const answer = yield* nextRecord(events, (record) => record.kind === 'answer')
      expect(answer).toMatchObject({ kind: 'answer', waitSeq: 1, wait: 'elicit' })

      const terminal = yield* nextTerminal(events)
      expect(terminal).toMatchObject({ kind: 'terminal', outcome: 'result', payload: { confirmed: true } })
      expect((yield* session.status()).state).toBe('completed')
    })
  })

  it('projects local sample sessions into the base session contract', async () => {
    await run(function* () {
      const toolSession = yield* createToolSession(SampleTool, {}, samplingProvider, {
        sessionId: 'local-contract-sample',
      })
      const session = yield* adaptToolSessionToSessionContract(toolSession)
      const events = yield* session.events()

      const wait = yield* nextWait(events)
      expect(wait.wait).toBe('sample')
      expect(wait.waitSeq).toBe(1)

      const pending = yield* expectOnePendingWait(session, 'sample')
      yield* session.respond(
        pending.token,
        { text: 'cat' },
        { idempotencyKey: 'local-sample-answer', wait: 'sample' },
      )

      const terminal = yield* nextTerminal(events)
      expect(terminal).toMatchObject({ kind: 'terminal', outcome: 'result', payload: { text: 'cat' } })
    })
  })
})

function* expectOnePendingWait(session: Session, kind: 'elicit' | 'sample'): Operation<{ token: string; waitSeq: number; kind: 'elicit' | 'sample' }> {
  const status = yield* session.status()
  expect(status.state).toBe('parked')
  expect(status.pendingWaits).toHaveLength(1)
  expect(status.pendingWaits[0]?.kind).toBe(kind)
  return status.pendingWaits[0] as { token: string; waitSeq: number; kind: 'elicit' | 'sample' }
}

function* nextWait(events: Subscription<LogRecord, void>): Operation<Extract<LogRecord, { kind: 'wait' }>> {
  return yield* nextRecord(events, (record): record is Extract<LogRecord, { kind: 'wait' }> => record.kind === 'wait')
}

function* nextTerminal(events: Subscription<LogRecord, void>): Operation<Extract<LogRecord, { kind: 'terminal' }>> {
  return yield* nextRecord(events, (record): record is Extract<LogRecord, { kind: 'terminal' }> => record.kind === 'terminal')
}

function* nextRecord<TRecord extends LogRecord>(
  events: Subscription<LogRecord, void>,
  predicate: (record: LogRecord) => record is TRecord,
): Operation<TRecord>
function* nextRecord(
  events: Subscription<LogRecord, void>,
  predicate: (record: LogRecord) => boolean,
): Operation<LogRecord>
function* nextRecord(
  events: Subscription<LogRecord, void>,
  predicate: (record: LogRecord) => boolean,
): Operation<LogRecord> {
  let next = yield* events.next()
  while (!next.done) {
    if (predicate(next.value)) {
      return next.value
    }
    next = yield* events.next()
  }
  throw new Error('Expected matching record before stream completion')
}

function* assertUnsupportedSend(session: Session): Operation<void> {
  try {
    yield* session.send({ role: 'user', content: 'nope' })
    throw new Error('expected unsupported_operation')
  } catch (error) {
    expect(error).toMatchObject({ code: 'unsupported_operation' })
  }
}
