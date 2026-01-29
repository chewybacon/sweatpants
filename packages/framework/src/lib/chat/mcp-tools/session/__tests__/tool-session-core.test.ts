/**
 * Core-Based Tool Session Tests
 *
 * Tests the host-side session that receives worker messages
 * and emits them as session events.
 */

import { describe, it, expect } from 'vitest'
import { run, sleep } from 'effection'
import { createInProcessTransportPair } from '../worker-thread-transport.ts'
import { createCoreToolSession } from '../tool-session-core.ts'
import type { ToolSessionEvent, SampleRequestEvent, ElicitRequestEvent } from '../types.ts'

describe('createCoreToolSession', () => {
  describe('session creation', () => {
    it('should create a session with provided options', async () => {
      await run(function* () {
        const [hostTransport] = createInProcessTransportPair()

        const session = yield* createCoreToolSession(hostTransport, {
          sessionId: 'test-session-123',
          toolName: 'test_tool',
        })

        expect(session.id).toBe('test-session-123')
        expect(session.toolName).toBe('test_tool')

        const status = yield* session.status()
        expect(status).toBe('running')

        hostTransport.close()
      })
    })

    it('should generate session ID if not provided', async () => {
      await run(function* () {
        const [hostTransport] = createInProcessTransportPair()

        const session = yield* createCoreToolSession(hostTransport, {
          toolName: 'test_tool',
        })

        expect(session.id).toMatch(/^session_\d+_[a-z0-9]+$/)

        hostTransport.close()
      })
    })
  })

  describe('sample_request handling', () => {
    it('should emit SampleRequestEvent when worker sends sample_request', async () => {
      await run(function* () {
        const [hostTransport, workerTransport] = createInProcessTransportPair()

        const session = yield* createCoreToolSession(hostTransport, {
          sessionId: 'test-session',
          toolName: 'test_tool',
        })

        // Start listening for events
        const events: ToolSessionEvent[] = []
        const eventStream = session.events()
        const sub = yield* eventStream

        // Simulate worker sending a sample request
        workerTransport.send({
          type: 'sample_request',
          sampleId: 'sample_001',
          messages: [{ role: 'user', content: 'Hello, world!' }],
          systemPrompt: 'You are helpful',
          maxTokens: 100,
          lsn: 1,
        })

        // Wait for event to arrive
        yield* sleep(50)

        // Get the event
        const result = yield* sub.next()
        if (!result.done) {
          events.push(result.value)
        }

        expect(events.length).toBe(1)
        expect(events[0].type).toBe('sample_request')

        const sampleEvent = events[0] as SampleRequestEvent
        expect(sampleEvent.sampleId).toBe('sample_001')
        expect(sampleEvent.messages).toEqual([{ role: 'user', content: 'Hello, world!' }])
        expect(sampleEvent.systemPrompt).toBe('You are helpful')
        expect(sampleEvent.maxTokens).toBe(100)

        // Status should be awaiting_sample
        const status = yield* session.status()
        expect(status).toBe('awaiting_sample')

        hostTransport.close()
      })
    })

    it('should handle respondToSample and resume running state', async () => {
      await run(function* () {
        const [hostTransport, workerTransport] = createInProcessTransportPair()

        const session = yield* createCoreToolSession(hostTransport, {
          sessionId: 'test-session',
          toolName: 'test_tool',
        })

        // Simulate worker sending a sample request
        workerTransport.send({
          type: 'sample_request',
          sampleId: 'sample_001',
          messages: [{ role: 'user', content: 'Hello' }],
          lsn: 1,
        })

        yield* sleep(50)

        // Check status before responding
        let status = yield* session.status()
        expect(status).toBe('awaiting_sample')

        // Capture the response sent back to worker
        let responseReceived: unknown = null
        workerTransport.subscribe((msg) => {
          if (msg.type === 'sample_response') {
            responseReceived = msg
          }
        })

        // Respond to sample
        yield* session.respondToSample('sample_001', {
          text: 'Hello! How can I help?',
          model: 'test-model',
          stopReason: 'endTurn',
        })

        yield* sleep(50)

        // Status should be back to running
        status = yield* session.status()
        expect(status).toBe('running')

        // Worker should have received the response
        expect(responseReceived).toMatchObject({
          type: 'sample_response',
          sampleId: 'sample_001',
          response: {
            text: 'Hello! How can I help?',
            model: 'test-model',
            stopReason: 'endTurn',
          },
        })

        hostTransport.close()
      })
    })

    it('should reject respondToSample with wrong sampleId', async () => {
      await run(function* () {
        const [hostTransport, workerTransport] = createInProcessTransportPair()

        const session = yield* createCoreToolSession(hostTransport, {
          sessionId: 'test-session',
          toolName: 'test_tool',
        })

        // Simulate worker sending a sample request
        workerTransport.send({
          type: 'sample_request',
          sampleId: 'sample_001',
          messages: [{ role: 'user', content: 'Hello' }],
          lsn: 1,
        })

        yield* sleep(50)

        // Try to respond with wrong ID - should throw
        let error: Error | null = null
        try {
          yield* session.respondToSample('wrong_id', {
            text: 'Response',
            model: 'test-model',
            stopReason: 'endTurn',
          })
        } catch (e) {
          error = e as Error
        }

        expect(error).not.toBeNull()
        expect(error!.message).toContain('Sample ID mismatch')

        hostTransport.close()
      })
    })
  })

  describe('elicit_request handling', () => {
    it('should emit ElicitRequestEvent when worker sends elicit_request', async () => {
      await run(function* () {
        const [hostTransport, workerTransport] = createInProcessTransportPair()

        const session = yield* createCoreToolSession(hostTransport, {
          sessionId: 'test-session',
          toolName: 'test_tool',
        })

        const events: ToolSessionEvent[] = []
        const eventStream = session.events()
        const sub = yield* eventStream

        // Simulate worker sending an elicit request
        workerTransport.send({
          type: 'elicit_request',
          elicitId: 'elicit_001',
          key: 'confirm_action',
          message: 'Do you want to proceed?',
          schema: { type: 'object', properties: { confirmed: { type: 'boolean' } } },
          lsn: 1,
        })

        yield* sleep(50)

        const result = yield* sub.next()
        if (!result.done) {
          events.push(result.value)
        }

        expect(events.length).toBe(1)
        expect(events[0].type).toBe('elicit_request')

        const elicitEvent = events[0] as ElicitRequestEvent
        expect(elicitEvent.elicitId).toBe('elicit_001')
        expect(elicitEvent.key).toBe('confirm_action')
        expect(elicitEvent.message).toBe('Do you want to proceed?')

        const status = yield* session.status()
        expect(status).toBe('awaiting_elicit')

        hostTransport.close()
      })
    })

    it('should handle respondToElicit with accept', async () => {
      await run(function* () {
        const [hostTransport, workerTransport] = createInProcessTransportPair()

        const session = yield* createCoreToolSession(hostTransport, {
          sessionId: 'test-session',
          toolName: 'test_tool',
        })

        // Simulate elicit request
        workerTransport.send({
          type: 'elicit_request',
          elicitId: 'elicit_001',
          key: 'confirm',
          message: 'Confirm?',
          schema: {},
          lsn: 1,
        })

        yield* sleep(50)

        // Capture response
        let responseReceived: unknown = null
        workerTransport.subscribe((msg) => {
          if (msg.type === 'elicit_response') {
            responseReceived = msg
          }
        })

        // Respond with accept
        yield* session.respondToElicit('elicit_001', {
          action: 'accept',
          content: { confirmed: true },
        })

        yield* sleep(50)

        expect(responseReceived).toMatchObject({
          type: 'elicit_response',
          elicitId: 'elicit_001',
          response: {
            action: 'accept',
            content: { confirmed: true },
          },
        })

        const status = yield* session.status()
        expect(status).toBe('running')

        hostTransport.close()
      })
    })

    it('should handle respondToElicit with decline', async () => {
      await run(function* () {
        const [hostTransport, workerTransport] = createInProcessTransportPair()

        const session = yield* createCoreToolSession(hostTransport, {
          sessionId: 'test-session',
          toolName: 'test_tool',
        })

        workerTransport.send({
          type: 'elicit_request',
          elicitId: 'elicit_001',
          key: 'confirm',
          message: 'Confirm?',
          schema: {},
          lsn: 1,
        })

        yield* sleep(50)

        let responseReceived: unknown = null
        workerTransport.subscribe((msg) => {
          if (msg.type === 'elicit_response') {
            responseReceived = msg
          }
        })

        yield* session.respondToElicit('elicit_001', {
          action: 'decline',
        })

        yield* sleep(50)

        expect(responseReceived).toMatchObject({
          type: 'elicit_response',
          elicitId: 'elicit_001',
          response: { action: 'decline' },
        })

        hostTransport.close()
      })
    })
  })

  describe('log and progress events', () => {
    it('should emit LogEvent when worker sends log message', async () => {
      await run(function* () {
        const [hostTransport, workerTransport] = createInProcessTransportPair()

        const session = yield* createCoreToolSession(hostTransport, {
          sessionId: 'test-session',
          toolName: 'test_tool',
        })

        const events: ToolSessionEvent[] = []
        const eventStream = session.events()
        const sub = yield* eventStream

        workerTransport.send({
          type: 'log',
          level: 'info',
          message: 'Processing started',
          lsn: 1,
        })

        yield* sleep(50)

        const result = yield* sub.next()
        if (!result.done) {
          events.push(result.value)
        }

        expect(events.length).toBe(1)
        expect(events[0].type).toBe('log')
        expect((events[0] as { level: string }).level).toBe('info')
        expect((events[0] as { message: string }).message).toBe('Processing started')

        hostTransport.close()
      })
    })

    it('should emit ProgressEvent when worker sends progress message', async () => {
      await run(function* () {
        const [hostTransport, workerTransport] = createInProcessTransportPair()

        const session = yield* createCoreToolSession(hostTransport, {
          sessionId: 'test-session',
          toolName: 'test_tool',
        })

        const events: ToolSessionEvent[] = []
        const eventStream = session.events()
        const sub = yield* eventStream

        workerTransport.send({
          type: 'progress',
          message: 'Halfway done',
          progress: 0.5,
          lsn: 1,
        })

        yield* sleep(50)

        const result = yield* sub.next()
        if (!result.done) {
          events.push(result.value)
        }

        expect(events.length).toBe(1)
        expect(events[0].type).toBe('progress')
        expect((events[0] as { message: string }).message).toBe('Halfway done')
        expect((events[0] as { progress: number }).progress).toBe(0.5)

        hostTransport.close()
      })
    })
  })

  describe('completion events', () => {
    it('should emit ResultEvent and close when worker sends result', async () => {
      await run(function* () {
        const [hostTransport, workerTransport] = createInProcessTransportPair()

        const session = yield* createCoreToolSession<{ greeting: string }>(hostTransport, {
          sessionId: 'test-session',
          toolName: 'test_tool',
        })

        const events: ToolSessionEvent<{ greeting: string }>[] = []
        const eventStream = session.events()
        const sub = yield* eventStream

        workerTransport.send({
          type: 'result',
          result: { greeting: 'Hello!' },
          lsn: 1,
        })

        yield* sleep(50)

        const result = yield* sub.next()
        if (!result.done) {
          events.push(result.value)
        }

        expect(events.length).toBe(1)
        expect(events[0].type).toBe('result')
        expect((events[0] as { result: { greeting: string } }).result).toEqual({ greeting: 'Hello!' })

        const status = yield* session.status()
        expect(status).toBe('completed')

        hostTransport.close()
      })
    })

    it('should emit ErrorEvent and close when worker sends error', async () => {
      await run(function* () {
        const [hostTransport, workerTransport] = createInProcessTransportPair()

        const session = yield* createCoreToolSession(hostTransport, {
          sessionId: 'test-session',
          toolName: 'test_tool',
        })

        const events: ToolSessionEvent[] = []
        const eventStream = session.events()
        const sub = yield* eventStream

        workerTransport.send({
          type: 'error',
          name: 'TestError',
          message: 'Something went wrong',
          stack: 'Error: Something went wrong\n    at test.ts:1:1',
          lsn: 1,
        })

        yield* sleep(50)

        const result = yield* sub.next()
        if (!result.done) {
          events.push(result.value)
        }

        expect(events.length).toBe(1)
        expect(events[0].type).toBe('error')
        expect((events[0] as { name: string }).name).toBe('TestError')
        expect((events[0] as { message: string }).message).toBe('Something went wrong')

        const status = yield* session.status()
        expect(status).toBe('failed')

        hostTransport.close()
      })
    })

    it('should emit CancelledEvent when worker sends cancelled', async () => {
      await run(function* () {
        const [hostTransport, workerTransport] = createInProcessTransportPair()

        const session = yield* createCoreToolSession(hostTransport, {
          sessionId: 'test-session',
          toolName: 'test_tool',
        })

        const events: ToolSessionEvent[] = []
        const eventStream = session.events()
        const sub = yield* eventStream

        workerTransport.send({
          type: 'cancelled',
          reason: 'User requested cancellation',
          lsn: 1,
        })

        yield* sleep(50)

        const result = yield* sub.next()
        if (!result.done) {
          events.push(result.value)
        }

        expect(events.length).toBe(1)
        expect(events[0].type).toBe('cancelled')
        expect((events[0] as { reason?: string }).reason).toBe('User requested cancellation')

        const status = yield* session.status()
        expect(status).toBe('cancelled')

        hostTransport.close()
      })
    })
  })

  describe('cancellation', () => {
    it('should send cancel message to worker when cancel is called', async () => {
      await run(function* () {
        const [hostTransport, workerTransport] = createInProcessTransportPair()

        const session = yield* createCoreToolSession(hostTransport, {
          sessionId: 'test-session',
          toolName: 'test_tool',
        })

        // Capture cancel message
        let cancelReceived: unknown = null
        workerTransport.subscribe((msg) => {
          if (msg.type === 'cancel') {
            cancelReceived = msg
          }
        })

        yield* session.cancel('User requested')

        yield* sleep(50)

        expect(cancelReceived).toMatchObject({
          type: 'cancel',
          reason: 'User requested',
        })

        const status = yield* session.status()
        expect(status).toBe('cancelled')

        hostTransport.close()
      })
    })

    it('should send cancel without reason when none provided', async () => {
      await run(function* () {
        const [hostTransport, workerTransport] = createInProcessTransportPair()

        const session = yield* createCoreToolSession(hostTransport, {
          sessionId: 'test-session',
          toolName: 'test_tool',
        })

        let cancelReceived: unknown = null
        workerTransport.subscribe((msg) => {
          if (msg.type === 'cancel') {
            cancelReceived = msg
          }
        })

        yield* session.cancel()

        yield* sleep(50)

        expect(cancelReceived).toMatchObject({ type: 'cancel' })
        expect((cancelReceived as { reason?: string }).reason).toBeUndefined()

        hostTransport.close()
      })
    })

    it('should not cancel if already completed', async () => {
      await run(function* () {
        const [hostTransport, workerTransport] = createInProcessTransportPair()

        const session = yield* createCoreToolSession(hostTransport, {
          sessionId: 'test-session',
          toolName: 'test_tool',
        })

        // Complete the session first
        workerTransport.send({
          type: 'result',
          result: { done: true },
          lsn: 1,
        })

        yield* sleep(50)

        // Try to cancel
        let cancelReceived = false
        workerTransport.subscribe((msg) => {
          if (msg.type === 'cancel') {
            cancelReceived = true
          }
        })

        yield* session.cancel()

        yield* sleep(50)

        // Cancel should not have been sent
        expect(cancelReceived).toBe(false)

        // Status should still be completed
        const status = yield* session.status()
        expect(status).toBe('completed')

        hostTransport.close()
      })
    })
  })

  describe('event sequencing', () => {
    it('should assign incrementing LSN to events', async () => {
      await run(function* () {
        const [hostTransport, workerTransport] = createInProcessTransportPair()

        const session = yield* createCoreToolSession(hostTransport, {
          sessionId: 'test-session',
          toolName: 'test_tool',
        })

        const events: ToolSessionEvent[] = []
        const eventStream = session.events()
        const sub = yield* eventStream

        // Send multiple events
        workerTransport.send({ type: 'log', level: 'info', message: 'First', lsn: 1 })
        workerTransport.send({ type: 'progress', message: 'Second', progress: 0.5, lsn: 2 })
        workerTransport.send({ type: 'log', level: 'info', message: 'Third', lsn: 3 })

        yield* sleep(100)

        // Collect events
        for (let i = 0; i < 3; i++) {
          const result = yield* sub.next()
          if (!result.done) {
            events.push(result.value)
          }
        }

        expect(events.length).toBe(3)
        expect(events[0].lsn).toBe(1)
        expect(events[1].lsn).toBe(2)
        expect(events[2].lsn).toBe(3)

        // All should have timestamps
        expect(events[0].timestamp).toBeDefined()
        expect(events[1].timestamp).toBeDefined()
        expect(events[2].timestamp).toBeDefined()

        hostTransport.close()
      })
    })
  })

  describe('ready message', () => {
    it('should ignore ready message from worker', async () => {
      await run(function* () {
        const [hostTransport, workerTransport] = createInProcessTransportPair()

        const session = yield* createCoreToolSession(hostTransport, {
          sessionId: 'test-session',
          toolName: 'test_tool',
        })

        // Worker sends ready
        workerTransport.send({ type: 'ready' })

        yield* sleep(50)

        // Status should still be running (not affected by ready)
        const status = yield* session.status()
        expect(status).toBe('running')

        hostTransport.close()
      })
    })
  })
})
