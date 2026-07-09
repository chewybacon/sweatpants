import { run, sleep, spawn } from 'effection'
import { describe, expect, it } from 'vitest'

import {
  createInMemorySession,
  createSessionContractInMemoryStore,
  spawnFoldDriver,
  waitToken,
  type AgentConfig,
  type AnswerPayload,
  type CapabilityResolver,
  type FoldSessionHost,
  type InMemorySession,
  type LogRecord,
  type ModelProvider,
} from '../index.ts'

function createRecordingModel(responses: AnswerPayload[], delayMs = 0): ModelProvider & { requests: unknown[] } {
  let index = 0
  const requests: unknown[] = []
  return {
    requests,
    *sample(request) {
      requests.push(JSON.parse(JSON.stringify(request)))
      if (delayMs > 0) {
        yield* sleep(delayMs)
      }
      const response = responses[index] ?? responses.at(-1) ?? { ok: true, value: 'fallback' }
      index = Math.min(index + 1, Math.max(responses.length - 1, 0))
      return response
    },
  }
}

function* createBootstrappedFoldSession(sessionId: string): Generator<unknown, InMemorySession, unknown> {
  const store = createSessionContractInMemoryStore()
  const session = yield* createInMemorySession({ sessionId, mode: 'fold', bufferStore: store })
  yield* session.checkpoint('fold')
  yield* session.emitWait('message', {})
  return session
}

function* waitForRecords(
  session: InMemorySession,
  predicate: (records: LogRecord[]) => boolean,
  description: string,
  timeoutMs = 1000,
): Generator<unknown, LogRecord[], unknown> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() <= deadline) {
    const records = yield* session.records()
    if (predicate(records)) {
      return records
    }
    yield* sleep(10)
  }
  throw new Error(`Timed out waiting for ${description}`)
}

function* waitForPendingWait(
  session: InMemorySession,
  kind: string,
  timeoutMs = 1000,
): Generator<unknown, { waitSeq: number; token: string; kind: string }, unknown> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() <= deadline) {
    const status = yield* session.status()
    const wait = status.pendingWaits.find((pending) => pending.kind === kind)
    if (wait) {
      return wait
    }
    yield* sleep(10)
  }
  throw new Error(`Timed out waiting for pending ${kind} wait`)
}

function answerPayloads(records: LogRecord[], wait: string): AnswerPayload[] {
  return records
    .filter((record): record is Extract<LogRecord, { kind: 'answer' }> => record.kind === 'answer' && record.wait === wait)
    .map((record) => record.payload)
}

describe('spawnFoldDriver Phase 2 parity and robustness', () => {
  it('runs a plain assistant turn through sample, emission, checkpoint, and next message wait', async () => {
    await run(function* () {
      const session = yield* createBootstrappedFoldSession('phase2-plain-turn')
      const model = createRecordingModel([{ ok: true, value: 'plain response' }])
      const config: AgentConfig = { name: 'plain', system: 'be concise', model }

      yield* spawn(function* () {
        yield* spawnFoldDriver(session, config)
      })
      yield* session.send({ role: 'user', content: 'hello' }, { idempotencyKey: 'plain-message' })

      const records = yield* waitForRecords(
        session,
        (all) => all.filter((record) => record.kind === 'wait' && record.wait === 'message').length === 2,
        'plain turn completion',
      )

      expect(model.requests).toHaveLength(1)
      expect(model.requests[0]).toMatchObject({
        messages: [{ role: 'user', content: 'hello' }],
        options: { system: 'be concise' },
      })
      expect(records.some((record) => record.kind === 'wait' && record.wait === 'sample')).toBe(true)
      expect(answerPayloads(records, 'sample')).toEqual([{ ok: true, value: 'plain response' }])
      expect(records).toContainEqual(expect.objectContaining({
        kind: 'emission',
        payload: { type: 'agent_turn_result', result: { ok: true, value: 'plain response' } },
      }))
      expect(records.at(-2)).toMatchObject({ kind: 'checkpoint', mode: 'fold' })
      expect(records.at(-1)).toMatchObject({ kind: 'wait', wait: 'message' })
    })
  })

  it('feeds a single canonical tool call result back into the follow-up model transcript', async () => {
    await run(function* () {
      const session = yield* createBootstrappedFoldSession('phase2-single-tool')
      const model = createRecordingModel([
        {
          ok: true,
          value: {
            calls: [{ id: 'calculator-call', target: 'calculator', input: { expression: '2+2' } }],
            assistantText: 'I will calculate.',
          },
        },
        { ok: true, value: 'The answer is 4.' },
      ])
      const resolver: CapabilityResolver = {
        *call(target, input) {
          return { ok: true, value: { target, input, result: 4 } }
        },
      }
      const config: AgentConfig = {
        name: 'single-tool',
        capabilities: { calculator: { description: 'calculate' } },
        model,
        resolver,
      }

      yield* spawn(function* () {
        yield* spawnFoldDriver(session, config)
      })
      yield* session.send({ role: 'user', content: 'what is 2+2?' }, { idempotencyKey: 'single-tool-message' })

      yield* waitForRecords(
        session,
        (all) => all.filter((record) => record.kind === 'wait' && record.wait === 'sample').length === 2,
        'single tool follow-up sample',
      )

      expect(model.requests).toHaveLength(2)
      expect(model.requests[1]).toMatchObject({
        messages: [
          { role: 'user', content: 'what is 2+2?' },
          {
            role: 'assistant',
            content: 'I will calculate.',
            tool_calls: [expect.objectContaining({ id: 'calculator-call', function: { name: 'calculator', arguments: { expression: '2+2' } } })],
          },
          { role: 'tool', tool_call_id: 'calculator-call', content: '4' },
        ],
      })
    })
  })

  it('correlates parallel tool calls by call ID in resolver calls and model transcript', async () => {
    await run(function* () {
      const session = yield* createBootstrappedFoldSession('phase2-parallel-tool-transcript')
      const model = createRecordingModel([
        {
          ok: true,
          value: {
            calls: [
              { id: 'weather-call', target: 'lookup', input: { kind: 'weather' } },
              { id: 'time-call', target: 'lookup', input: { kind: 'time' } },
            ],
          },
        },
        { ok: true, value: 'Done.' },
      ])
      const seenCallIds: string[] = []
      const resolver: CapabilityResolver & { callWithId: (target: string, input: unknown, callId: string) => Generator<unknown, AnswerPayload, unknown> } = {
        *call() {
          throw new Error('callWithId should be used')
        },
        *callWithId(_target, input, callId) {
          seenCallIds.push(callId)
          return { ok: true, value: { callId, input } }
        },
      }

      yield* spawn(function* () {
        yield* spawnFoldDriver(session, {
          name: 'parallel-tool-transcript',
          capabilities: { lookup: { description: 'lookup' } },
          model,
          resolver,
        })
      })
      yield* session.send({ role: 'user', content: 'lookup both' }, { idempotencyKey: 'parallel-tool-message' })

      yield* waitForRecords(
        session,
        (all) => all.filter((record) => record.kind === 'answer' && record.wait === 'call').length === 2,
        'parallel tool answers',
      )

      expect(seenCallIds).toEqual(['weather-call', 'time-call'])
      expect(model.requests[1]).toMatchObject({
        messages: expect.arrayContaining([
          { role: 'tool', tool_call_id: 'weather-call', content: JSON.stringify({ callId: 'weather-call', input: { kind: 'weather' } }) },
          { role: 'tool', tool_call_id: 'time-call', content: JSON.stringify({ callId: 'time-call', input: { kind: 'time' } }) },
        ]),
      })
    })
  })

  it('parks at an elicitation boundary inside a tool resolver and resumes the correct wait', async () => {
    await run(function* () {
      const session = yield* createBootstrappedFoldSession('phase2-elicit-boundary')
      const model = createRecordingModel([
        { ok: true, value: { calls: [{ id: 'approval-tool', target: 'approval', input: { action: 'ship' } }] } },
        { ok: true, value: 'Approved and complete.' },
      ])
      const resolver: CapabilityResolver & {
        callWithSession: (
          target: string,
          input: unknown,
          context: { parent: FoldSessionHost; callWaitSeq: number },
        ) => Generator<unknown, AnswerPayload, unknown>
      } = {
        *call() {
          throw new Error('callWithSession should be used')
        },
        *callWithSession(_target, _input, { parent }) {
          const elicit = yield* parent.emitWait('elicit', {
            key: 'approve',
            message: 'Approve?',
            responseSchema: { type: 'object' },
          })
          const records = yield* waitForRecords(
            parent,
            (all) => all.some((record) => record.kind === 'answer' && record.waitSeq === elicit.waitSeq),
            'elicit answer',
          )
          const answer = records.find((record) => record.kind === 'answer' && record.waitSeq === elicit.waitSeq)
          return { ok: true, value: { approved: (answer?.payload as AnswerPayload<{ approved: boolean }>).value.approved } }
        },
      }

      yield* spawn(function* () {
        yield* spawnFoldDriver(session, {
          name: 'elicit-boundary',
          capabilities: { approval: { description: 'approval' } },
          model,
          resolver,
        })
      })
      yield* session.send({ role: 'user', content: 'ship it' }, { idempotencyKey: 'elicit-message' })

      const pendingElicit = yield* waitForPendingWait(session, 'elicit')
      expect((yield* session.status()).pendingWaits.map((wait) => wait.kind)).toEqual(['call', 'elicit'])

      yield* session.respond(pendingElicit.token, { approved: true }, {
        idempotencyKey: 'approval-answer',
        wait: 'elicit',
      })

      const records = yield* waitForRecords(
        session,
        (all) => all.filter((record) => record.kind === 'wait' && record.wait === 'message').length === 2,
        'post-elicit turn completion',
      )
      expect(answerPayloads(records, 'call').at(-1)).toEqual({ ok: true, value: { approved: true } })
    })
  })

  it('allows session-aware model providers to emit streaming text and reasoning before the turn result', async () => {
    await run(function* () {
      const session = yield* createBootstrappedFoldSession('phase2-streaming-emissions')
      const model: ModelProvider & {
        sampleWithSession: (
          request: Parameters<ModelProvider['sample']>[0],
          context: { session: FoldSessionHost; sampleWaitSeq: number },
        ) => Generator<unknown, AnswerPayload, unknown>
      } = {
        *sample() {
          throw new Error('sampleWithSession should be used')
        },
        *sampleWithSession(_request, { session: parent }) {
          yield* parent.emitEmission({ type: 'text_delta', delta: 'hel' })
          yield* parent.emitEmission({ type: 'reasoning_delta', delta: 'thinking' })
          yield* parent.emitEmission({ type: 'text_delta', delta: 'lo' })
          return { ok: true, value: 'hello' }
        },
      }

      yield* spawn(function* () {
        yield* spawnFoldDriver(session, { name: 'streaming', model })
      })
      yield* session.send({ role: 'user', content: 'stream' }, { idempotencyKey: 'stream-message' })

      const records = yield* waitForRecords(
        session,
        (all) => all.some((record) => record.kind === 'emission' && (record.payload as { type?: string }).type === 'agent_turn_result'),
        'streaming turn result',
      )
      const emissions = records.filter((record) => record.kind === 'emission')
      expect(emissions.map((record) => (record.payload as { type?: string }).type)).toEqual([
        'text_delta',
        'reasoning_delta',
        'text_delta',
        'agent_turn_result',
      ])
    })
  })

  it('records deterministic terminal errors for model errors, unsupported model values, and fatal tool errors', async () => {
    await run(function* () {
      const modelErrorSession = yield* createBootstrappedFoldSession('phase2-model-error')
      yield* spawn(function* () {
        yield* spawnFoldDriver(modelErrorSession, {
          name: 'model-error',
          model: createRecordingModel([{ ok: false, code: 'model_down', message: 'model unavailable' }]),
        })
      })
      yield* modelErrorSession.send({ role: 'user', content: 'fail' }, { idempotencyKey: 'model-error-message' })
      yield* waitForRecords(modelErrorSession, (all) => all.some((record) => record.kind === 'terminal'), 'model error terminal')
      expect((yield* modelErrorSession.status())).toMatchObject({ state: 'failed', terminal: { outcome: 'error' } })

      const unsupportedSession = yield* createBootstrappedFoldSession('phase2-unsupported-model')
      yield* spawn(function* () {
        yield* spawnFoldDriver(unsupportedSession, {
          name: 'unsupported-model',
          model: createRecordingModel([{ ok: true, value: { unexpected: true } }]),
        })
      })
      yield* unsupportedSession.send({ role: 'user', content: 'unsupported' }, { idempotencyKey: 'unsupported-message' })
      yield* waitForRecords(unsupportedSession, (all) => all.some((record) => record.kind === 'terminal'), 'unsupported terminal')
      expect((yield* unsupportedSession.status()).terminal?.payload).toMatchObject({ ok: false, code: 'model_error' })

      const toolFatalSession = yield* createBootstrappedFoldSession('phase2-tool-fatal')
      yield* spawn(function* () {
        yield* spawnFoldDriver(toolFatalSession, {
          name: 'tool-fatal',
          capabilities: { worker: { description: 'worker' } },
          model: createRecordingModel([{ ok: true, value: { calls: [{ id: 'fatal', target: 'worker', input: {} }] } }]),
          resolver: {
            *call() {
              return { ok: false, code: 'session_lost', message: 'child lost' }
            },
          },
        })
      })
      yield* toolFatalSession.send({ role: 'user', content: 'tool fatal' }, { idempotencyKey: 'tool-fatal-message' })
      yield* waitForRecords(toolFatalSession, (all) => all.some((record) => record.kind === 'terminal'), 'tool fatal terminal')
      expect((yield* toolFatalSession.status()).terminal?.payload).toMatchObject({ ok: false, code: 'session_lost' })
    })
  })

  it('continues after non-fatal tool_error answers and emits max_iterations_reached when bounded', async () => {
    await run(function* () {
      const toolErrorSession = yield* createBootstrappedFoldSession('phase2-tool-error-nonfatal')
      const toolErrorModel = createRecordingModel([
        { ok: true, value: { calls: [{ id: 'recoverable', target: 'worker', input: {} }] } },
        { ok: true, value: 'Recovered from tool error.' },
      ])
      yield* spawn(function* () {
        yield* spawnFoldDriver(toolErrorSession, {
          name: 'tool-error-nonfatal',
          capabilities: { worker: { description: 'worker' } },
          model: toolErrorModel,
          resolver: {
            *call() {
              return { ok: false, code: 'tool_error', message: 'tool failed recoverably' }
            },
          },
        })
      })
      yield* toolErrorSession.send({ role: 'user', content: 'recover' }, { idempotencyKey: 'recoverable-tool-message' })
      yield* waitForRecords(
        toolErrorSession,
        (all) => all.filter((record) => record.kind === 'wait' && record.wait === 'message').length === 2,
        'recoverable tool error completion',
      )
      expect(toolErrorModel.requests).toHaveLength(2)
      expect((yield* toolErrorSession.status()).state).toBe('parked')

      const maxSession = yield* createBootstrappedFoldSession('phase2-max-iterations')
      yield* spawn(function* () {
        yield* spawnFoldDriver(maxSession, {
          name: 'max-iterations',
          maxIterations: 2,
          capabilities: { worker: { description: 'worker' } },
          model: createRecordingModel([
            { ok: true, value: { calls: [{ id: 'loop-1', target: 'worker', input: { n: 1 } }] } },
            { ok: true, value: { calls: [{ id: 'loop-2', target: 'worker', input: { n: 2 } }] } },
          ]),
          resolver: {
            *call() {
              return { ok: true, value: 'again' }
            },
          },
        })
      })
      yield* maxSession.send({ role: 'user', content: 'loop' }, { idempotencyKey: 'max-message' })
      const maxRecords = yield* waitForRecords(
        maxSession,
        (all) => all.some((record) => record.kind === 'emission' && (record.payload as { type?: string }).type === 'max_iterations_reached'),
        'max iterations emission',
      )
      expect(maxRecords.filter((record) => record.kind === 'wait' && record.wait === 'sample')).toHaveLength(2)
      expect((yield* maxSession.status()).state).toBe('parked')
    })
  })

  it('handles cancellation during sample, call, and elicit waits without advancing the turn', async () => {
    await run(function* () {
      const sampleSession = yield* createBootstrappedFoldSession('phase2-cancel-sample')
      yield* spawn(function* () {
        yield* spawnFoldDriver(sampleSession, {
          name: 'cancel-sample',
          model: createRecordingModel([{ ok: true, value: 'too late' }], 100),
        })
      })
      yield* sampleSession.send({ role: 'user', content: 'cancel sample' }, { idempotencyKey: 'cancel-sample-message' })
      yield* waitForPendingWait(sampleSession, 'sample')
      yield* sampleSession.cancel('user')
      yield* sleep(150)
      expect((yield* sampleSession.status()).state).toBe('cancelled')
      expect((yield* sampleSession.records()).some((record) => record.kind === 'emission' && (record.payload as { type?: string }).type === 'agent_turn_result')).toBe(false)

      const callSession = yield* createBootstrappedFoldSession('phase2-cancel-call')
      yield* spawn(function* () {
        yield* spawnFoldDriver(callSession, {
          name: 'cancel-call',
          capabilities: { worker: { description: 'worker' } },
          model: createRecordingModel([{ ok: true, value: { calls: [{ id: 'slow-call', target: 'worker', input: {} }] } }]),
          resolver: {
            *call() {
              yield* sleep(100)
              return { ok: true, value: 'too late' }
            },
          },
        })
      })
      yield* callSession.send({ role: 'user', content: 'cancel call' }, { idempotencyKey: 'cancel-call-message' })
      yield* waitForPendingWait(callSession, 'call')
      yield* callSession.cancel('user')
      yield* sleep(150)
      expect((yield* callSession.status()).state).toBe('cancelled')
      expect(answerPayloads(yield* callSession.records(), 'call')).toEqual([])

      const elicitSession = yield* createBootstrappedFoldSession('phase2-cancel-elicit')
      yield* spawn(function* () {
        yield* spawnFoldDriver(elicitSession, {
          name: 'cancel-elicit',
          capabilities: { approval: { description: 'approval' } },
          model: createRecordingModel([{ ok: true, value: { calls: [{ id: 'needs-user', target: 'approval', input: {} }] } }]),
          resolver: {
            *call() {
              throw new Error('callWithSession should be used')
            },
            *callWithSession(_target, _input, { parent }: { parent: FoldSessionHost }) {
              yield* parent.emitWait('elicit', { key: 'approve', message: 'Approve?', responseSchema: {} })
              while (true) {
                const status = yield* parent.status()
                if (status.terminal) {
                  return { ok: false, code: 'cancelled', message: 'cancelled' }
                }
                yield* sleep(10)
              }
            },
          } as CapabilityResolver,
        })
      })
      yield* elicitSession.send({ role: 'user', content: 'cancel elicit' }, { idempotencyKey: 'cancel-elicit-message' })
      yield* waitForPendingWait(elicitSession, 'elicit')
      yield* elicitSession.cancel('user')
      yield* sleep(50)
      expect((yield* elicitSession.status()).state).toBe('cancelled')
    })
  })

  it('derives restore actions for parked message, pending sample, pending call, and pending elicit states', async () => {
    await run(function* () {
      const parked = yield* createBootstrappedFoldSession('phase2-restore-message')
      yield* spawn(function* () {
        yield* spawnFoldDriver(parked, { name: 'restore-message', model: createRecordingModel([{ ok: true, value: 'unused' }]) })
      })
      yield* sleep(50)
      expect((yield* parked.status()).pendingWaits.map((wait) => wait.kind)).toEqual(['message'])

      const sample = yield* createBootstrappedFoldSession('phase2-restore-sample')
      yield* sample.emitWait('sample', { messages: [{ role: 'user', content: 'resume' }] })
      yield* spawn(function* () {
        yield* spawnFoldDriver(sample, { name: 'restore-sample', model: createRecordingModel([{ ok: true, value: 'resampled' }]) })
      })
      const sampleRecords = yield* waitForRecords(
        sample,
        (all) => all.filter((record) => record.kind === 'wait' && record.wait === 'sample').length === 2,
        'sample restore re-sample',
      )
      expect(answerPayloads(sampleRecords, 'sample')[0]).toMatchObject({ ok: false, code: 'session_lost' })

      const call = yield* createBootstrappedFoldSession('phase2-restore-call')
      const callWait = yield* call.emitWait('call', { target: 'worker', input: { resume: true } })
      yield* spawn(function* () {
        yield* spawnFoldDriver(call, {
          name: 'restore-call',
          resolver: {
            *call() {
              throw new Error('reattachCall should be used')
            },
            *reattachCall(waitSeq: number) {
              return { ok: true, value: { reattached: waitSeq } }
            },
          } as CapabilityResolver,
        })
      })
      const callRecords = yield* waitForRecords(
        call,
        (all) => all.some((record) => record.kind === 'answer' && record.wait === 'call'),
        'call restore reattach',
      )
      expect(answerPayloads(callRecords, 'call')).toEqual([{ ok: true, value: { reattached: callWait.waitSeq } }])

      const elicit = yield* createBootstrappedFoldSession('phase2-restore-elicit')
      const elicitWait = yield* elicit.emitWait('elicit', { key: 'resume', message: 'Resume?', responseSchema: {} })
      yield* spawn(function* () {
        yield* spawnFoldDriver(elicit, { name: 'restore-elicit' })
      })
      yield* sleep(50)
      const elicitStatus = yield* elicit.status()
      expect(elicitStatus.pendingWaits.map((wait) => wait.kind)).toEqual(['message', 'elicit'])
      expect(elicitStatus.pendingWaits.find((wait) => wait.kind === 'elicit')?.token).toBe(waitToken(elicit.id, elicitWait.waitSeq))
    })
  })
})
