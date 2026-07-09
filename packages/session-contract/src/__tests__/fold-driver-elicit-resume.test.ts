import { run, spawn, sleep } from 'effection'
import { describe, it, expect } from 'vitest'

import {
  spawnFoldDriver,
  createInMemorySession,
  createSessionContractInMemoryStore,
  waitToken,
  deriveLogState,
  type AgentConfig,
  type AnswerPayload,
  type ModelProvider,
  type CapabilityResolver,
  type FoldSessionHost,
} from '../index.ts'

function createStubModel(responses: AnswerPayload[]): ModelProvider {
  let index = 0
  return {
    *sample() {
      const response = responses[index] ?? { ok: true, value: 'fallback' }
      index = Math.min(index + 1, responses.length - 1)
      return response
    },
  }
}

function createTranscriptCheckingModel(options: {
  toolName: string
  toolResult: unknown
  finalText: string
}): ModelProvider {
  let sampleCount = 0
  return {
    *sample(request) {
      sampleCount += 1
      if (sampleCount === 1) {
        return {
          ok: true,
          value: {
            calls: [{ id: 'c1', target: options.toolName, input: {} }],
            assistantText: '',
          },
        }
      }

      const messages = Array.isArray((request as { messages?: unknown }).messages)
        ? ((request as { messages: unknown[] }).messages)
        : []
      const expectedContent = typeof options.toolResult === 'string'
        ? options.toolResult
        : JSON.stringify(options.toolResult)
      const hasToolResult = messages.some((message) =>
        Boolean(
          message &&
            typeof message === 'object' &&
            (message as { role?: unknown }).role === 'tool' &&
            (message as { tool_call_id?: unknown }).tool_call_id === 'c1' &&
            (message as { content?: unknown }).content === expectedContent,
        )
      )

      if (!hasToolResult) {
        return {
          ok: false,
          code: 'missing_tool_result_in_transcript',
          message: 'Continuation sample did not include the tool result transcript',
        }
      }

      return { ok: true, value: options.finalText }
    },
  }
}

/**
 * Resolver that supports elicit-suspend-resume via `callWithSession` and
 * `reattachCall`. This mirrors the adapter's resolver interface.
 */
interface ElicitResolverOptions {
  /** Return this from the initial call (should be tool_awaiting_elicit). */
  elicitAnswer: AnswerPayload
  /** Return this from reattachCall after the elicit is answered. */
  reattachAnswer: AnswerPayload;
  /** Tool target name. */
  target: string;
}

function createElicitResolver(opts: ElicitResolverOptions): CapabilityResolver {
  const maybeSessionAware = {
    *callWithSession(
      _target: string,
      _input: unknown,
      context: { parent: FoldSessionHost; callWaitSeq: number; callId?: string },
    ): Operation<AnswerPayload> {
      // Emit an elicit wait on the parent session so the client can answer it.
      yield* context.parent.emitWait('elicit', {
        key: 'pickFlight',
        message: 'Pick a flight',
        responseSchema: {},
        metadata: { callId: context.callId, callWaitSeq: context.callWaitSeq },
      })
      return opts.elicitAnswer
    },
    *reattachCall(callWaitSeq: number, _context: { session: FoldSessionHost; callId?: string }): Operation<AnswerPayload | null> {
      void callWaitSeq
      return opts.reattachAnswer
    },
  }
  return maybeSessionAware as unknown as CapabilityResolver
}

describe('fold driver elicit-suspend-resume', () => {
  it('parks on tool_awaiting_elicit without recording the call as a failure', async () => {
    await run(function* () {
      const store = createSessionContractInMemoryStore()
      const session = yield* createInMemorySession({ sessionId: 'elicit-park', mode: 'fold', bufferStore: store })

      yield* session.checkpoint('fold')
      yield* session.emitWait('message', {})

      const resolver = createElicitResolver({
        target: 'book_flight',
        elicitAnswer: { ok: false, code: 'tool_awaiting_elicit', message: 'Pick a flight' },
        reattachAnswer: { ok: true, value: { callId: 'c1', toolName: 'book_flight', result: 'TKT-123' } },
      })

      const config: AgentConfig = {
        name: 'test',
        capabilities: { book_flight: { description: 'book a flight' } },
        model: createStubModel([
          { ok: true, value: { calls: [{ id: 'c1', target: 'book_flight', input: {} }], assistantText: '' } },
          { ok: true, value: 'Your flight is booked!' },
        ]),
        resolver,
      }

      yield* spawn(function* () {
        yield* spawnFoldDriver(session, config)
      })

      yield* session.send({ role: 'user', content: 'book a flight' })
      yield* sleep(100)

      const records = yield* session.records()
      const state = deriveLogState(session.id, records)

      // The call wait should still be pending (NOT answered with a failure).
      const callWaits = records.filter((r) => r.kind === 'wait' && r.wait === 'call')
      expect(callWaits).toHaveLength(1)

      const callWaitSeq = callWaits[0]!.waitSeq
      const callAnswer = state.answers.get(callWaitSeq)
      expect(callAnswer).toBeUndefined()

      // An elicit wait should exist.
      const elicitWaits = records.filter((r) => r.kind === 'wait' && r.wait === 'elicit')
      expect(elicitWaits).toHaveLength(1)

      // Session should not be terminal.
      expect(state.terminal).toBeUndefined()

      // There should be a pending call wait and a pending elicit wait.
      const pendingCallWait = state.pendingWaits.find((w) => w.kind === 'call')
      expect(pendingCallWait).toBeDefined()
      const pendingElicitWait = state.pendingWaits.find((w) => w.kind === 'elicit')
      expect(pendingElicitWait).toBeDefined()
    })
  })

  it('decideAction parks when elicit is pending, fires reattach_call after elicit is answered', async () => {
    await run(function* () {
      const store = createSessionContractInMemoryStore()
      const session = yield* createInMemorySession({ sessionId: 'elicit-decide', mode: 'fold', bufferStore: store })

      yield* session.checkpoint('fold')
      yield* session.emitWait('message', {})

      const resolver = createElicitResolver({
        target: 'book_flight',
        elicitAnswer: { ok: false, code: 'tool_awaiting_elicit', message: 'Pick a flight' },
        reattachAnswer: { ok: true, value: { callId: 'c1', toolName: 'book_flight', result: 'TKT-123' } },
      })

      const config: AgentConfig = {
        name: 'test',
        capabilities: { book_flight: { description: 'book a flight' } },
        model: createStubModel([
          { ok: true, value: { calls: [{ id: 'c1', target: 'book_flight', input: {} }], assistantText: '' } },
          { ok: true, value: 'Your flight is booked!' },
        ]),
        resolver,
      }

      yield* spawn(function* () {
        yield* spawnFoldDriver(session, config)
      })

      yield* session.send({ role: 'user', content: 'book a flight' })
      yield* sleep(100)

      const records = yield* session.records()
      let state = deriveLogState(session.id, records)

      // While elicit is pending, decideAction should park.
      const pendingElicit = state.pendingWaits.find((w) => w.kind === 'elicit')
      expect(pendingElicit).toBeDefined()

      // Answer the elicit wait.
      const elicitWait = records.find((r) => r.kind === 'wait' && r.wait === 'elicit')!
      yield* session.respondIfPending(
        waitToken(session.id, elicitWait.waitSeq),
        { ok: true, value: { flightId: 'FL001' } },
        { wait: 'elicit' },
      )

      // Now decideAction should fire reattach_call for the pending call wait.
      state = deriveLogState(session.id, yield* session.records())
      const pendingCall = state.pendingWaits.find((w) => w.kind === 'call')
      expect(pendingCall).toBeDefined()
      // No pending elicit anymore.
      const stillPendingElicit = state.pendingWaits.find((w) => w.kind === 'elicit')
      expect(stillPendingElicit).toBeUndefined()
    })
  })

  it('full resume cycle: elicit answered → reattach → tool result → model continuation → turn completes', async () => {
    await run(function* () {
      const store = createSessionContractInMemoryStore()
      const session = yield* createInMemorySession({ sessionId: 'elicit-resume', mode: 'fold', bufferStore: store })

      yield* session.checkpoint('fold')
      yield* session.emitWait('message', {})

      const resolver = createElicitResolver({
        target: 'book_flight',
        elicitAnswer: { ok: false, code: 'tool_awaiting_elicit', message: 'Pick a flight' },
        reattachAnswer: { ok: true, value: { callId: 'c1', toolName: 'book_flight', result: 'TKT-123' } },
      })

      const config: AgentConfig = {
        name: 'test',
        capabilities: { book_flight: { description: 'book a flight' } },
        model: createTranscriptCheckingModel({
          toolName: 'book_flight',
          toolResult: 'TKT-123',
          finalText: 'Your flight is booked!',
        }),
        resolver,
      }

      // --- Initial turn ---
      yield* spawn(function* () {
        yield* spawnFoldDriver(session, config)
      })
      yield* session.send({ role: 'user', content: 'book a flight' })
      yield* sleep(100)

      // Should be parked at elicit.
      let records = yield* session.records()
      let state = deriveLogState(session.id, records)
      expect(state.pendingWaits.some((w) => w.kind === 'elicit')).toBe(true)

      // --- Resume: answer elicit ---
      const elicitWait = records.find((r) => r.kind === 'wait' && r.wait === 'elicit')!
      yield* session.respondIfPending(
        waitToken(session.id, elicitWait.waitSeq),
        { ok: true, value: { flightId: 'FL001' } },
        { wait: 'elicit' },
      )
      yield* sleep(200)

      // --- Verify: turn completed ---
      records = yield* session.records()
      state = deriveLogState(session.id, records)

      // Call wait should now be answered (with the tool result from reattach).
      const callWait = records.find((r) => r.kind === 'wait' && r.wait === 'call')!
      const callAnswer = state.answers.get(callWait.waitSeq)
      expect(callAnswer).toBeDefined()
      expect(callAnswer!.payload).toMatchObject({ ok: true, value: { result: 'TKT-123' } })

      // Two sample waits: initial (tool call) + continuation (text response).
      const sampleWaits = records.filter((r) => r.kind === 'wait' && r.wait === 'sample')
      expect(sampleWaits).toHaveLength(2)

      // Session should reach the final message wait (turn complete).
      const messageWaits = records.filter((r) => r.kind === 'wait' && r.wait === 'message')
      expect(messageWaits.length).toBeGreaterThanOrEqual(2)

      // Session should NOT be terminal (it's waiting for the next message).
      expect(state.terminal).toBeUndefined()
    })
  })

  it('multi-elicit: pickFlight → pickSeat → result → model continuation', async () => {
    await run(function* () {
      const store = createSessionContractInMemoryStore()
      const session = yield* createInMemorySession({ sessionId: 'multi-elicit', mode: 'fold', bufferStore: store })

      yield* session.checkpoint('fold')
      yield* session.emitWait('message', {})

      // Resolver that emits a different elicit each time it's called/reattached.
      let elicitCount = 0
      const maybeSessionAware = {
        *callWithSession(
          _target: string,
          _input: unknown,
          context: { parent: FoldSessionHost; callWaitSeq: number; callId?: string },
        ): Operation<AnswerPayload> {
          elicitCount += 1
          yield* context.parent.emitWait('elicit', {
            key: elicitCount === 1 ? 'pickFlight' : 'pickSeat',
            message: elicitCount === 1 ? 'Pick a flight' : 'Pick a seat',
            responseSchema: {},
            metadata: { callId: context.callId, callWaitSeq: context.callWaitSeq },
          })
          return { ok: false, code: 'tool_awaiting_elicit', message: 'waiting for user' }
        },
        *reattachCall(_callWaitSeq: number, _context: { session: FoldSessionHost; callId?: string }): Operation<AnswerPayload | null> {
          elicitCount += 1
          if (elicitCount <= 2) {
            // Still eliciting — emit next elicit (pickSeat after pickFlight).
            yield* session.emitWait('elicit', {
              key: 'pickSeat',
              message: 'Pick a seat',
              responseSchema: {},
              metadata: {},
            })
            return { ok: false, code: 'tool_awaiting_elicit', message: 'waiting for user' }
          }
          // Third reattach: return the final result.
          return { ok: true, value: { callId: 'c1', toolName: 'book_flight', result: 'TKT-456' } }
        },
      }
      const resolver = maybeSessionAware as unknown as CapabilityResolver

      const config: AgentConfig = {
        name: 'test',
        capabilities: { book_flight: { description: 'book a flight' } },
        model: createTranscriptCheckingModel({
          toolName: 'book_flight',
          toolResult: 'TKT-456',
          finalText: 'Booking confirmed!',
        }),
        resolver,
      }

      // --- Initial turn ---
      yield* spawn(function* () {
        yield* spawnFoldDriver(session, config)
      })
      yield* session.send({ role: 'user', content: 'book a flight' })
      yield* sleep(100)

      let records = yield* session.records()
      let elicitWaits = records.filter((r) => r.kind === 'wait' && r.wait === 'elicit')
      expect(elicitWaits).toHaveLength(1)
      expect((elicitWaits[0]!.payload as { key: string }).key).toBe('pickFlight')

      // --- Resume 1: answer pickFlight ---
      yield* session.respondIfPending(
        waitToken(session.id, elicitWaits[0]!.waitSeq),
        { ok: true, value: { flightId: 'FL001' } },
        { wait: 'elicit' },
      )
      yield* sleep(200)

      records = yield* session.records()
      elicitWaits = records.filter((r) => r.kind === 'wait' && r.wait === 'elicit')
      expect(elicitWaits).toHaveLength(2)
      expect((elicitWaits[1]!.payload as { key: string }).key).toBe('pickSeat')

      // --- Resume 2: answer pickSeat ---
      yield* session.respondIfPending(
        waitToken(session.id, elicitWaits[1]!.waitSeq),
        { ok: true, value: { row: 1, seat: 'A' } },
        { wait: 'elicit' },
      )
      yield* sleep(200)

      // --- Verify: turn completed ---
      records = yield* session.records()
      const state = deriveLogState(session.id, records)

      // Call wait should be answered with the tool result.
      const callWait = records.find((r) => r.kind === 'wait' && r.wait === 'call')!
      const callAnswer = state.answers.get(callWait.waitSeq)
      expect(callAnswer).toBeDefined()
      expect(callAnswer!.payload).toMatchObject({ ok: true, value: { result: 'TKT-456' } })

      // Two sample waits: initial (tool call) + continuation (text response).
      const sampleWaits = records.filter((r) => r.kind === 'wait' && r.wait === 'sample')
      expect(sampleWaits).toHaveLength(2)

      // Session should reach the final message wait.
      const messageWaits = records.filter((r) => r.kind === 'wait' && r.wait === 'message')
      expect(messageWaits.length).toBeGreaterThanOrEqual(2)

      // Session should NOT be terminal.
      expect(state.terminal).toBeUndefined()
    })
  })
})
