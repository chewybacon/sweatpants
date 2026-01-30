/**
 * Tests for Signal-Based Correlated Transport
 *
 * See docs/adr-signal-based-transport.md for architecture rationale.
 */

import { describe, it, expect, vi } from 'vitest'
import { run, spawn, sleep } from 'effection'
import { createSignalCorrelatedTransport } from '../signal-correlated-transport.ts'
import { createInProcessTransportPair } from '../worker-thread-transport.ts'
import type { WorkerTransport, HostToWorkerMessage, WorkerToHostMessage } from '../worker-types.ts'

describe('createSignalCorrelatedTransport', () => {
  describe('basic transport creation', () => {
    it('should create a correlated transport', async () => {
      await run(function* () {
        const [_hostTransport, workerTransport] = createInProcessTransportPair()
        const transport = yield* createSignalCorrelatedTransport(workerTransport)

        expect(transport).toBeDefined()
        expect(typeof transport.request).toBe('function')
      })
    })

    it('should cleanup subscription on resource teardown', async () => {
      const unsubscribeSpy = vi.fn()

      const mockTransport: WorkerTransport = {
        send: vi.fn(),
        subscribe: vi.fn(() => unsubscribeSpy),
        close: vi.fn(),
      }

      await run(function* () {
        yield* createSignalCorrelatedTransport(mockTransport)
        // Transport is created, subscription should be active
        expect(mockTransport.subscribe).toHaveBeenCalled()
      })

      // After run completes, unsubscribe should have been called
      expect(unsubscribeSpy).toHaveBeenCalled()
    })
  })

  describe('sample request/response', () => {
    it('should send sample_request and receive sample_response', async () => {
      await run(function* () {
        const [hostTransport, workerTransport] = createInProcessTransportPair()

        // Collect messages sent to host
        const hostMessages: WorkerToHostMessage[] = []
        hostTransport.subscribe((msg) => hostMessages.push(msg))

        const transport = yield* createSignalCorrelatedTransport(workerTransport)

        // Spawn a task to respond to sample request
        yield* spawn(function* () {
          yield* sleep(10) // Wait for request to be sent

          // Find the sample request
          const sampleReq = hostMessages.find(m => m.type === 'sample_request')
          expect(sampleReq).toBeDefined()
          expect(sampleReq?.type).toBe('sample_request')

          // Send response
          hostTransport.send({
            type: 'sample_response',
            sampleId: (sampleReq as { sampleId: string }).sampleId,
            response: {
              text: 'Hello from LLM',
              model: 'test-model',
              stopReason: 'endTurn',
            },
          })
        })

        // Make the request
        const stream = transport.request({
          id: 'test-sample-1',
          kind: 'elicit',
          type: 'sample',
          payload: {
            messages: [{ role: 'user', content: 'Hi' }],
          },
        })

        const subscription = yield* stream
        const result = yield* subscription.next()

        expect(result.done).toBe(true)
        expect(result.value).toEqual({
          status: 'accepted',
          content: {
            text: 'Hello from LLM',
            model: 'test-model',
            stopReason: 'endTurn',
          },
        })
      })
    })

    it('should use message.id as the sampleId', async () => {
      await run(function* () {
        const [hostTransport, workerTransport] = createInProcessTransportPair()

        const hostMessages: WorkerToHostMessage[] = []
        hostTransport.subscribe((msg) => hostMessages.push(msg))

        const transport = yield* createSignalCorrelatedTransport(workerTransport)

        // Spawn responder
        yield* spawn(function* () {
          yield* sleep(10)
          const sampleReq = hostMessages.find(m => m.type === 'sample_request') as { sampleId: string }
          expect(sampleReq.sampleId).toBe('my-custom-id')

          hostTransport.send({
            type: 'sample_response',
            sampleId: sampleReq.sampleId,
            response: { text: 'OK' },
          })
        })

        const stream = transport.request({
          id: 'my-custom-id',
          kind: 'elicit',
          type: 'sample',
          payload: { messages: [] },
        })

        const subscription = yield* stream
        yield* subscription.next()
      })
    })

    it('should handle multiple concurrent sample requests', async () => {
      await run(function* () {
        const [hostTransport, workerTransport] = createInProcessTransportPair()

        const hostMessages: WorkerToHostMessage[] = []
        hostTransport.subscribe((msg) => hostMessages.push(msg))

        const transport = yield* createSignalCorrelatedTransport(workerTransport)

        // Spawn responder that handles multiple requests
        yield* spawn(function* () {
          yield* sleep(20)

          // Respond to all sample requests
          for (const msg of hostMessages) {
            if (msg.type === 'sample_request') {
              const sampleReq = msg as { sampleId: string }
              hostTransport.send({
                type: 'sample_response',
                sampleId: sampleReq.sampleId,
                response: { text: `Response for ${sampleReq.sampleId}` },
              })
            }
          }
        })

        // Make multiple concurrent requests
        const results: string[] = []

        yield* spawn(function* () {
          const stream = transport.request({
            id: 'req-1',
            kind: 'elicit',
            type: 'sample',
            payload: { messages: [] },
          })
          const sub = yield* stream
          const result = yield* sub.next()
          results.push((result.value as { content: { text: string } }).content.text)
        })

        yield* spawn(function* () {
          const stream = transport.request({
            id: 'req-2',
            kind: 'elicit',
            type: 'sample',
            payload: { messages: [] },
          })
          const sub = yield* stream
          const result = yield* sub.next()
          results.push((result.value as { content: { text: string } }).content.text)
        })

        yield* sleep(50)

        expect(results).toContain('Response for req-1')
        expect(results).toContain('Response for req-2')
      })
    })
  })

  describe('elicit request/response', () => {
    it('should send elicit_request and receive elicit_response (accept)', async () => {
      await run(function* () {
        const [hostTransport, workerTransport] = createInProcessTransportPair()

        const hostMessages: WorkerToHostMessage[] = []
        hostTransport.subscribe((msg) => hostMessages.push(msg))

        const transport = yield* createSignalCorrelatedTransport(workerTransport)

        yield* spawn(function* () {
          yield* sleep(10)

          const elicitReq = hostMessages.find(m => m.type === 'elicit_request')
          expect(elicitReq).toBeDefined()

          hostTransport.send({
            type: 'elicit_response',
            elicitId: (elicitReq as { elicitId: string }).elicitId,
            response: {
              action: 'accept',
              content: { selectedFlight: 'FL123' },
            },
          })
        })

        const stream = transport.request({
          id: 'elicit-1',
          kind: 'elicit',
          type: 'pickFlight',
          payload: {
            key: 'pickFlight',
            message: 'Choose a flight',
            schema: { type: 'object' },
          },
        })

        const subscription = yield* stream
        const result = yield* subscription.next()

        expect(result.done).toBe(true)
        expect(result.value).toEqual({
          status: 'accepted',
          content: { selectedFlight: 'FL123' },
        })
      })
    })

    it('should handle elicit decline', async () => {
      await run(function* () {
        const [hostTransport, workerTransport] = createInProcessTransportPair()

        const hostMessages: WorkerToHostMessage[] = []
        hostTransport.subscribe((msg) => hostMessages.push(msg))

        const transport = yield* createSignalCorrelatedTransport(workerTransport)

        yield* spawn(function* () {
          yield* sleep(10)

          const elicitReq = hostMessages.find(m => m.type === 'elicit_request') as { elicitId: string }
          hostTransport.send({
            type: 'elicit_response',
            elicitId: elicitReq.elicitId,
            response: { action: 'decline' },
          })
        })

        const stream = transport.request({
          id: 'elicit-decline',
          kind: 'elicit',
          type: 'confirm',
          payload: { key: 'confirm', message: 'OK?', schema: {} },
        })

        const subscription = yield* stream
        const result = yield* subscription.next()

        expect(result.value).toEqual({ status: 'declined' })
      })
    })

    it('should handle elicit cancel', async () => {
      await run(function* () {
        const [hostTransport, workerTransport] = createInProcessTransportPair()

        const hostMessages: WorkerToHostMessage[] = []
        hostTransport.subscribe((msg) => hostMessages.push(msg))

        const transport = yield* createSignalCorrelatedTransport(workerTransport)

        yield* spawn(function* () {
          yield* sleep(10)

          const elicitReq = hostMessages.find(m => m.type === 'elicit_request') as { elicitId: string }
          hostTransport.send({
            type: 'elicit_response',
            elicitId: elicitReq.elicitId,
            response: { action: 'cancel' },
          })
        })

        const stream = transport.request({
          id: 'elicit-cancel',
          kind: 'elicit',
          type: 'confirm',
          payload: { key: 'confirm', message: 'OK?', schema: {} },
        })

        const subscription = yield* stream
        const result = yield* subscription.next()

        expect(result.value).toEqual({ status: 'cancelled' })
      })
    })
  })

  describe('notify (fire-and-forget)', () => {
    it('should send log messages', async () => {
      await run(function* () {
        const [hostTransport, workerTransport] = createInProcessTransportPair()

        const hostMessages: WorkerToHostMessage[] = []
        hostTransport.subscribe((msg) => hostMessages.push(msg))

        const transport = yield* createSignalCorrelatedTransport(workerTransport)

        // Notify is fire-and-forget, but we still need to yield the stream
        // to trigger the resource which sends the message
        yield* spawn(function* () {
          const stream = transport.request({
            id: 'log-1',
            kind: 'notify',
            type: 'log',
            payload: {
              level: 'info',
              message: 'Something happened',
            },
          })
          yield* stream
          // For notify, we don't wait for response - the spawn will just wait forever
          // but that's fine since we're just testing message was sent
        })

        yield* sleep(10)

        const logMsg = hostMessages.find(m => m.type === 'log')
        expect(logMsg).toBeDefined()
        expect((logMsg as { level: string }).level).toBe('info')
        expect((logMsg as { message: string }).message).toBe('Something happened')
      })
    })

    it('should send progress messages', async () => {
      await run(function* () {
        const [hostTransport, workerTransport] = createInProcessTransportPair()

        const hostMessages: WorkerToHostMessage[] = []
        hostTransport.subscribe((msg) => hostMessages.push(msg))

        const transport = yield* createSignalCorrelatedTransport(workerTransport)

        yield* spawn(function* () {
          const stream = transport.request({
            id: 'progress-1',
            kind: 'notify',
            type: 'progress',
            payload: {
              message: 'Processing...',
              progress: 0.5,
            },
          })
          yield* stream
        })

        yield* sleep(10)

        const progressMsg = hostMessages.find(m => m.type === 'progress')
        expect(progressMsg).toBeDefined()
        expect((progressMsg as { message: string }).message).toBe('Processing...')
        expect((progressMsg as { progress: number }).progress).toBe(0.5)
      })
    })
  })

  describe('message mapping', () => {
    it('should map sample request payload correctly', async () => {
      await run(function* () {
        const [hostTransport, workerTransport] = createInProcessTransportPair()

        const hostMessages: WorkerToHostMessage[] = []
        hostTransport.subscribe((msg) => hostMessages.push(msg))

        const transport = yield* createSignalCorrelatedTransport(workerTransport)

        // Need to yield the stream to trigger the resource and send the message
        yield* spawn(function* () {
          const stream = transport.request({
            id: 'sample-mapping-test',
            kind: 'elicit',
            type: 'sample',
            payload: {
              messages: [
                { role: 'user', content: 'Hello' },
                { role: 'assistant', content: 'Hi there!' },
              ],
              systemPrompt: 'You are helpful',
              maxTokens: 1000,
            },
          })
          yield* stream
        })

        yield* sleep(10)

        const sampleReq = hostMessages.find(m => m.type === 'sample_request')
        expect(sampleReq).toBeDefined()
        expect((sampleReq as { sampleId: string }).sampleId).toBe('sample-mapping-test')
        expect((sampleReq as { messages: unknown[] }).messages).toHaveLength(2)
        expect((sampleReq as { systemPrompt: string }).systemPrompt).toBe('You are helpful')
        expect((sampleReq as { maxTokens: number }).maxTokens).toBe(1000)
      })
    })

    it('should map elicit request payload correctly', async () => {
      await run(function* () {
        const [hostTransport, workerTransport] = createInProcessTransportPair()

        const hostMessages: WorkerToHostMessage[] = []
        hostTransport.subscribe((msg) => hostMessages.push(msg))

        const transport = yield* createSignalCorrelatedTransport(workerTransport)

        yield* spawn(function* () {
          const stream = transport.request({
            id: 'elicit-mapping-test',
            kind: 'elicit',
            type: 'customElicit',
            payload: {
              key: 'selectOption',
              message: 'Please select an option',
              schema: { type: 'object', properties: { choice: { type: 'string' } } },
            },
          })
          yield* stream
        })

        yield* sleep(10)

        const elicitReq = hostMessages.find(m => m.type === 'elicit_request')
        expect(elicitReq).toBeDefined()
        expect((elicitReq as { elicitId: string }).elicitId).toBe('elicit-mapping-test')
        expect((elicitReq as { key: string }).key).toBe('selectOption')
        expect((elicitReq as { message: string }).message).toBe('Please select an option')
        expect((elicitReq as { schema: object }).schema).toEqual({
          type: 'object',
          properties: { choice: { type: 'string' } },
        })
      })
    })
  })

  describe('cleanup and edge cases', () => {
    it('should cleanup pending request on subscription teardown', async () => {
      await run(function* () {
        const [_hostTransport, workerTransport] = createInProcessTransportPair()
        const transport = yield* createSignalCorrelatedTransport(workerTransport)

        // Start a request but don't complete it
        let streamStarted = false
        yield* spawn(function* () {
          const stream = transport.request({
            id: 'cleanup-test',
            kind: 'elicit',
            type: 'sample',
            payload: { messages: [] },
          })
          yield* stream
          streamStarted = true
          // This would block forever waiting for response
          // but the spawn will be torn down when the test ends
        })

        yield* sleep(10)
        expect(streamStarted).toBe(true)

        // Test completes without hanging - cleanup is handled
      })
    })

    it('should ignore responses for unknown request IDs', async () => {
      await run(function* () {
        const [hostTransport, workerTransport] = createInProcessTransportPair()
        yield* createSignalCorrelatedTransport(workerTransport)

        // Send a response for a non-existent request
        // This should not throw
        hostTransport.send({
          type: 'sample_response',
          sampleId: 'non-existent-id',
          response: { text: 'ignored' },
        })

        yield* sleep(10)
        // Test passes if no error is thrown
      })
    })
  })
})
