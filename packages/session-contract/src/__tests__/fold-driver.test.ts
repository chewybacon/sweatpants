import { run, spawn, sleep } from 'effection'
import { describe, it, expect } from 'vitest'

import {
  createAgent,
  spawnFoldDriver,
  createInMemorySession,
  createSessionContractInMemoryStore,
  waitToken,
  type AgentConfig,
  type InMemorySession,
  type AnswerPayload,
  type ModelProvider,
  type LogRecord,
} from '../index.ts'

/**
 * Stub model provider that returns canned responses with an optional delay.
 */
function createStubModel(responses: AnswerPayload[], delayMs = 0): ModelProvider {
  let index = 0
  return {
    *sample() {
      if (delayMs > 0) {
        yield* sleep(delayMs)
      }
      const response = responses[index] ?? { ok: true, value: 'fallback' }
      index = Math.min(index + 1, responses.length - 1)
      return response
    },
  }
}

describe('spawnFoldDriver (REQ-087, REQ-088)', () => {
  it('send() returns a SendAck before the fold turn begins', async () => {
    await run(function* () {
      const store = createSessionContractInMemoryStore()
      const session = yield* createInMemorySession({ sessionId: 'async-send', mode: 'fold', bufferStore: store })

      // Bootstrap the session
      yield* session.checkpoint('fold')
      yield* session.emitWait('message', {})

      const config: AgentConfig = {
        name: 'test',
        model: createStubModel([{ ok: true, value: 'hello response' }], 100),
      }

      // Spawn the driver
      yield* spawn(function* () {
        yield* spawnFoldDriver(session, config)
      })

      // send() should return immediately (before the 100ms model delay)
      const start = Date.now()
      const ack = yield* session.send({ role: 'user', content: 'hello' })
      const elapsed = Date.now() - start

      expect(ack.lsn).toBeDefined()
      expect(ack.idempotencyKey).toBeDefined()
      // send() should return well before the model responds (100ms delay)
      expect(elapsed).toBeLessThan(50)
    })
  })

  it('the driver runs the fold turn after send() returns', async () => {
    await run(function* () {
      const store = createSessionContractInMemoryStore()
      const session = yield* createInMemorySession({ sessionId: 'driver-turn', mode: 'fold', bufferStore: store })

      yield* session.checkpoint('fold')
      yield* session.emitWait('message', {})

      const config: AgentConfig = {
        name: 'test',
        model: createStubModel([{ ok: true, value: 'hello response' }]),
      }

      yield* spawn(function* () {
        yield* spawnFoldDriver(session, config)
      })

      yield* session.send({ role: 'user', content: 'hello' })

      // Wait for the driver to process the turn
      yield* sleep(100)

      const records = yield* session.records()
      const hasSampleWait = records.some((r) => r.kind === 'wait' && r.wait === 'sample')
      const hasSampleAnswer = records.some((r) => r.kind === 'answer' && r.wait === 'sample')
      const hasCheckpoint = records.some((r) => r.kind === 'checkpoint')
      const hasSecondMessageWait = records.filter((r) => r.kind === 'wait' && r.wait === 'message').length >= 2

      expect(hasSampleWait).toBe(true)
      expect(hasSampleAnswer).toBe(true)
      expect(hasCheckpoint).toBe(true)
      expect(hasSecondMessageWait).toBe(true)
    })
  })

  it('the driver is stateless — restore decisions come from the log', async () => {
    await run(function* () {
      const store = createSessionContractInMemoryStore()
      const session = yield* createInMemorySession({ sessionId: 'stateless-restore', mode: 'fold', bufferStore: store })

      yield* session.checkpoint('fold')
      yield* session.emitWait('message', {})

      const config: AgentConfig = {
        name: 'test',
        model: createStubModel([{ ok: true, value: 'response 1' }, { ok: true, value: 'response 2' }]),
      }

      // Send a message and let the driver process it
      yield* spawn(function* () {
        yield* spawnFoldDriver(session, config)
      })

      yield* session.send({ role: 'user', content: 'message 1' })
      yield* sleep(100)

      // Send another message
      yield* session.send({ role: 'user', content: 'message 2' })
      yield* sleep(100)

      const records = yield* session.records()
      // Should have 2 sample waits (one per turn)
      const sampleWaits = records.filter((r) => r.kind === 'wait' && r.wait === 'sample')
      expect(sampleWaits.length).toBe(2)
    })
  })

  it('handles mid-stream sample crash recovery (REQ-072)', async () => {
    await run(function* () {
      const store = createSessionContractInMemoryStore()
      const session = yield* createInMemorySession({ sessionId: 'crash-recovery', mode: 'fold', bufferStore: store })

      yield* session.checkpoint('fold')
      yield* session.emitWait('message', {})

      // Simulate a crash: emit a sample wait and some partial emissions,
      // then "crash" (don't answer the sample)
      yield* session.send({ role: 'user', content: 'hello' })
      yield* session.emitWait('sample', {
        messages: [{ role: 'user', content: 'hello' }],
      })
      yield* session.emitEmission({ type: 'text_delta', delta: 'par' })
      yield* session.emitEmission({ type: 'text_delta', delta: 'tial' })

      // Now restore — spawn a fresh driver
      const config: AgentConfig = {
        name: 'test',
        model: createStubModel([{ ok: true, value: 'fresh response' }]),
      }

      // The driver should detect the pending sample wait and re-sample
      yield* spawn(function* () {
        yield* spawnFoldDriver(session, config)
      })

      yield* sleep(100)

      const records = yield* session.records()
      // The old sample wait should have a session_lost answer
      const sampleAnswers = records.filter(
        (r) => r.kind === 'answer' && r.wait === 'sample',
      )
      expect(sampleAnswers.length).toBeGreaterThanOrEqual(1)

      // A new sample wait should be emitted (re-sample)
      const sampleWaits = records.filter((r) => r.kind === 'wait' && r.wait === 'sample')
      expect(sampleWaits.length).toBe(2)

      // The old partial emissions remain in the log (inert history)
      const emissions = records.filter((r) => r.kind === 'emission')
      expect(emissions.length).toBeGreaterThanOrEqual(2)
    })
  })
})
