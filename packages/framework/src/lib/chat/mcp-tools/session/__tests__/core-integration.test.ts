/**
 * Core-Based Integration Tests
 *
 * Tests the integration between core-based session and worker runner.
 * 
 * Uses the signal-based CorrelatedTransport implementation which correctly
 * handles the sample/elicit backchannel. See docs/adr-signal-based-transport.md
 * for the architecture rationale.
 */

import { describe, it, expect } from 'vitest'
import { run, sleep, spawn } from 'effection'
import { createInProcessTransportPair } from '../worker-thread-transport.ts'
import { runWorkerCore, createWorkerToolRegistry } from '../worker-runner-core.ts'
import { createCoreToolSession } from '../tool-session-core.ts'
import type { WorkerToolContext, WorkerToHostMessage } from '../worker-types.ts'
import type { ToolSessionEvent, SampleRequestEvent, ElicitRequestEvent } from '../types.ts'

// Helper to wait for a specific message type
function waitForMessage(
  messages: WorkerToHostMessage[],
  type: string,
  timeout = 2000
): Promise<WorkerToHostMessage> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeout
    const check = () => {
      const found = messages.find((m) => m.type === type)
      if (found) {
        resolve(found)
      } else if (Date.now() > deadline) {
        reject(new Error(`Timeout waiting for ${type}`))
      } else {
        setTimeout(check, 10)
      }
    }
    check()
  })
}

describe('Core-Based Integration', () => {
  describe('runWorkerCore with simple tools', () => {
    it('should execute a simple tool and receive result', async () => {
      const [hostTransport, workerTransport] = createInProcessTransportPair()

      const registry = createWorkerToolRegistry([
        {
          name: 'echo',
          *handler(params: unknown, ctx: WorkerToolContext) {
            ctx.log('info', 'Echoing message')
            const { message } = params as { message: string }
            return { echoed: message }
          },
        },
      ])

      const messages: WorkerToHostMessage[] = []
      hostTransport.subscribe((msg) => messages.push(msg))

      // Start worker
      runWorkerCore(workerTransport, registry)
      await waitForMessage(messages, 'ready')

      // Send start message
      hostTransport.send({
        type: 'start',
        toolName: 'echo',
        params: { message: 'hello world' },
        sessionId: 'test-session',
      })

      // Wait for result
      const result = await waitForMessage(messages, 'result')

      expect(result.type).toBe('result')
      expect((result as { result: unknown }).result).toEqual({ echoed: 'hello world' })

      // Verify we got log events
      const logs = messages.filter(m => m.type === 'log')
      expect(logs.length).toBeGreaterThan(0)

      hostTransport.close()
    })

    it('should receive log and progress events from tool', async () => {
      const [hostTransport, workerTransport] = createInProcessTransportPair()

      const registry = createWorkerToolRegistry([
        {
          name: 'logger',
          *handler(_params: unknown, ctx: WorkerToolContext) {
            ctx.log('info', 'Step 1')
            ctx.log('debug', 'Step 2')
            ctx.progress('Working...', 0.5)
            return { done: true }
          },
        },
      ])

      const messages: WorkerToHostMessage[] = []
      hostTransport.subscribe((msg) => messages.push(msg))

      runWorkerCore(workerTransport, registry)
      await waitForMessage(messages, 'ready')

      hostTransport.send({
        type: 'start',
        toolName: 'logger',
        params: {},
        sessionId: 'test-session',
      })

      await waitForMessage(messages, 'result')

      // Check we received all the events
      const logs = messages.filter(m => m.type === 'log')
      expect(logs.length).toBe(2)
      expect((logs[0] as { message: string }).message).toBe('Step 1')
      expect((logs[1] as { message: string }).message).toBe('Step 2')

      const progress = messages.filter(m => m.type === 'progress')
      expect(progress.length).toBe(1)
      expect((progress[0] as { message: string }).message).toBe('Working...')
      expect((progress[0] as { progress: number }).progress).toBe(0.5)

      hostTransport.close()
    })

    it('should handle tool errors gracefully', async () => {
      const [hostTransport, workerTransport] = createInProcessTransportPair()

      const registry = createWorkerToolRegistry([
        {
          name: 'failer',
          *handler() {
            throw new Error('Intentional test error')
          },
        },
      ])

      const messages: WorkerToHostMessage[] = []
      hostTransport.subscribe((msg) => messages.push(msg))

      runWorkerCore(workerTransport, registry)
      await waitForMessage(messages, 'ready')

      hostTransport.send({
        type: 'start',
        toolName: 'failer',
        params: {},
        sessionId: 'test-session',
      })

      const errorMsg = await waitForMessage(messages, 'error')

      expect(errorMsg.type).toBe('error')
      expect((errorMsg as { message: string }).message).toBe('Intentional test error')

      hostTransport.close()
    })

    it('should handle tool not found error', async () => {
      const [hostTransport, workerTransport] = createInProcessTransportPair()

      const registry = createWorkerToolRegistry([])

      const messages: WorkerToHostMessage[] = []
      hostTransport.subscribe((msg) => messages.push(msg))

      runWorkerCore(workerTransport, registry)
      await waitForMessage(messages, 'ready')

      hostTransport.send({
        type: 'start',
        toolName: 'nonexistent',
        params: {},
        sessionId: 'test-session',
      })

      const errorMsg = await waitForMessage(messages, 'error')

      expect(errorMsg.type).toBe('error')
      expect((errorMsg as { name: string }).name).toBe('ToolNotFound')
      expect((errorMsg as { message: string }).message).toContain('nonexistent')

      hostTransport.close()
    })
  })

  /**
   * Tests for sample/elicit backchannel using signal-based transport.
   * These tests verify the full round-trip: worker sends request, host responds, worker receives.
   */
  describe('runWorkerCore with sample/elicit', () => {
    it('should handle sample request/response flow', async () => {
      const [hostTransport, workerTransport] = createInProcessTransportPair()

      const registry = createWorkerToolRegistry([
        {
          name: 'sampler',
          *handler(_params: unknown, ctx: WorkerToolContext) {
            ctx.log('info', 'Starting sample')
            const result = yield* ctx.sample([{ role: 'user', content: 'Hello' }])
            return { response: result.text }
          },
        },
      ])

      const messages: WorkerToHostMessage[] = []
      hostTransport.subscribe((msg) => messages.push(msg))

      // Start worker
      runWorkerCore(workerTransport, registry)
      await waitForMessage(messages, 'ready')

      // Send start message
      hostTransport.send({
        type: 'start',
        toolName: 'sampler',
        params: {},
        sessionId: 'test-session',
      })

      // Wait for sample request
      const sampleReq = await waitForMessage(messages, 'sample_request') as { sampleId: string }
      expect(sampleReq.type).toBe('sample_request')

      // Send sample response
      hostTransport.send({
        type: 'sample_response',
        sampleId: sampleReq.sampleId,
        response: {
          text: 'Hello from LLM!',
          model: 'test-model',
          stopReason: 'endTurn',
        },
      })

      // Wait for result
      const result = await waitForMessage(messages, 'result')
      expect(result.type).toBe('result')
      expect((result as { result: { response: string } }).result).toEqual({ response: 'Hello from LLM!' })

      hostTransport.close()
    })

    it('should handle multiple sample requests in sequence', async () => {
      const [hostTransport, workerTransport] = createInProcessTransportPair()

      const registry = createWorkerToolRegistry([
        {
          name: 'multiSampler',
          *handler(_params: unknown, ctx: WorkerToolContext) {
            const result1 = yield* ctx.sample([{ role: 'user', content: 'First' }])
            const result2 = yield* ctx.sample([{ role: 'user', content: 'Second' }])
            return { responses: [result1.text, result2.text] }
          },
        },
      ])

      const messages: WorkerToHostMessage[] = []
      hostTransport.subscribe((msg) => messages.push(msg))

      runWorkerCore(workerTransport, registry)
      await waitForMessage(messages, 'ready')

      hostTransport.send({
        type: 'start',
        toolName: 'multiSampler',
        params: {},
        sessionId: 'test-session',
      })

      // Wait for first sample request
      const sampleReq1 = await waitForMessage(messages, 'sample_request') as { sampleId: string }
      hostTransport.send({
        type: 'sample_response',
        sampleId: sampleReq1.sampleId,
        response: { text: 'Response 1' },
      })

      // Wait for second sample request (need to find one with different ID)
      await new Promise(resolve => setTimeout(resolve, 50))
      const allSampleReqs = messages.filter(m => m.type === 'sample_request') as Array<{ sampleId: string }>
      const sampleReq2 = allSampleReqs.find(r => r.sampleId !== sampleReq1.sampleId)
      expect(sampleReq2).toBeDefined()

      hostTransport.send({
        type: 'sample_response',
        sampleId: sampleReq2!.sampleId,
        response: { text: 'Response 2' },
      })

      // Wait for result
      const result = await waitForMessage(messages, 'result')
      expect((result as { result: { responses: string[] } }).result).toEqual({
        responses: ['Response 1', 'Response 2'],
      })

      hostTransport.close()
    })

    it('should handle elicit request/response flow', async () => {
      const [hostTransport, workerTransport] = createInProcessTransportPair()

      const registry = createWorkerToolRegistry([
        {
          name: 'eliciter',
          *handler(_params: unknown, ctx: WorkerToolContext) {
            const result = yield* ctx.elicit('confirm', {
              message: 'Do you want to proceed?',
              schema: { type: 'object', properties: { confirmed: { type: 'boolean' } } },
            })
            return { userChoice: result }
          },
        },
      ])

      const messages: WorkerToHostMessage[] = []
      hostTransport.subscribe((msg) => messages.push(msg))

      runWorkerCore(workerTransport, registry)
      await waitForMessage(messages, 'ready')

      hostTransport.send({
        type: 'start',
        toolName: 'eliciter',
        params: {},
        sessionId: 'test-session',
      })

      // Wait for elicit request
      const elicitReq = await waitForMessage(messages, 'elicit_request') as {
        elicitId: string
        key: string
        message: string
      }
      expect(elicitReq.key).toBe('confirm')
      expect(elicitReq.message).toBe('Do you want to proceed?')

      // Send elicit response
      hostTransport.send({
        type: 'elicit_response',
        elicitId: elicitReq.elicitId,
        response: {
          action: 'accept',
          content: { confirmed: true },
        },
      })

      // Wait for result
      const result = await waitForMessage(messages, 'result')
      expect((result as { result: { userChoice: { action: string; content: { confirmed: boolean } } } }).result.userChoice.action).toBe('accept')
      expect((result as { result: { userChoice: { content: { confirmed: boolean } } } }).result.userChoice.content).toEqual({ confirmed: true })

      hostTransport.close()
    })

    it('should handle elicit decline', async () => {
      const [hostTransport, workerTransport] = createInProcessTransportPair()

      const registry = createWorkerToolRegistry([
        {
          name: 'decliner',
          *handler(_params: unknown, ctx: WorkerToolContext) {
            const result = yield* ctx.elicit('confirm', {
              message: 'Proceed?',
              schema: {},
            })
            return { action: result.action }
          },
        },
      ])

      const messages: WorkerToHostMessage[] = []
      hostTransport.subscribe((msg) => messages.push(msg))

      runWorkerCore(workerTransport, registry)
      await waitForMessage(messages, 'ready')

      hostTransport.send({
        type: 'start',
        toolName: 'decliner',
        params: {},
        sessionId: 'test-session',
      })

      const elicitReq = await waitForMessage(messages, 'elicit_request') as { elicitId: string }

      // User declines
      hostTransport.send({
        type: 'elicit_response',
        elicitId: elicitReq.elicitId,
        response: { action: 'decline' },
      })

      const result = await waitForMessage(messages, 'result')
      expect((result as { result: { action: string } }).result.action).toBe('decline')

      hostTransport.close()
    })

    it('should handle combined sample and elicit', async () => {
      const [hostTransport, workerTransport] = createInProcessTransportPair()

      const registry = createWorkerToolRegistry([
        {
          name: 'combined',
          *handler(_params: unknown, ctx: WorkerToolContext) {
            // First, sample the LLM
            const sampleResult = yield* ctx.sample([{ role: 'user', content: 'Generate options' }])
            
            // Then, elicit user choice
            const elicitResult = yield* ctx.elicit('pickOption', {
              message: `Pick from: ${sampleResult.text}`,
              schema: { type: 'object' },
            })
            
            return {
              llmSuggestion: sampleResult.text,
              userChoice: elicitResult.action === 'accept' ? elicitResult.content : null,
            }
          },
        },
      ])

      const messages: WorkerToHostMessage[] = []
      hostTransport.subscribe((msg) => messages.push(msg))

      runWorkerCore(workerTransport, registry)
      await waitForMessage(messages, 'ready')

      hostTransport.send({
        type: 'start',
        toolName: 'combined',
        params: {},
        sessionId: 'test-session',
      })

      // Handle sample request
      const sampleReq = await waitForMessage(messages, 'sample_request') as { sampleId: string }
      hostTransport.send({
        type: 'sample_response',
        sampleId: sampleReq.sampleId,
        response: { text: 'Option A, Option B, Option C' },
      })

      // Handle elicit request
      const elicitReq = await waitForMessage(messages, 'elicit_request') as {
        elicitId: string
        message: string
      }
      expect(elicitReq.message).toContain('Option A, Option B, Option C')

      hostTransport.send({
        type: 'elicit_response',
        elicitId: elicitReq.elicitId,
        response: {
          action: 'accept',
          content: { selected: 'Option B' },
        },
      })

      // Verify final result
      const result = await waitForMessage(messages, 'result')
      expect((result as { result: { llmSuggestion: string; userChoice: { selected: string } } }).result).toEqual({
        llmSuggestion: 'Option A, Option B, Option C',
        userChoice: { selected: 'Option B' },
      })

      hostTransport.close()
    })
  })

  describe('createCoreToolSession (session-only tests)', () => {
    it('should create session and collect events from simulated worker messages', async () => {
      await run(function* () {
        const [hostTransport, workerTransport] = createInProcessTransportPair()

        // Create session first
        const session = yield* createCoreToolSession<{ greeting: string }>(hostTransport, {
          sessionId: 'test-session',
          toolName: 'greeter',
        })

        // Collect events
        const events: ToolSessionEvent<{ greeting: string }>[] = []
        const eventStream = session.events()
        const sub = yield* eventStream

        // Spawn event collector
        yield* spawn(function* () {
          while (true) {
            const result = yield* sub.next()
            if (result.done) break
            events.push(result.value)
          }
        })

        // Simulate worker sending sample_request
        workerTransport.send({
          type: 'sample_request',
          sampleId: 'sample_001',
          messages: [{ role: 'user', content: 'Hello' }],
          lsn: 1,
        })

        yield* sleep(50)

        // Check we received the event
        const sampleEvent = events.find(e => e.type === 'sample_request') as SampleRequestEvent
        expect(sampleEvent).toBeDefined()
        expect(sampleEvent.sampleId).toBe('sample_001')

        // Session status should be awaiting_sample
        expect(yield* session.status()).toBe('awaiting_sample')

        // Respond to sample
        yield* session.respondToSample('sample_001', {
          text: 'Hi there!',
          model: 'test',
          stopReason: 'endTurn',
        })

        yield* sleep(50)

        // Session should be running again
        expect(yield* session.status()).toBe('running')

        // Simulate worker sending result
        workerTransport.send({
          type: 'result',
          result: { greeting: 'Hi there!' },
          lsn: 2,
        })

        yield* sleep(50)

        // Session should be completed
        expect(yield* session.status()).toBe('completed')

        hostTransport.close()
      })
    })

    it('should handle elicit flow via simulated worker messages', async () => {
      await run(function* () {
        const [hostTransport, workerTransport] = createInProcessTransportPair()

        const session = yield* createCoreToolSession(hostTransport, {
          sessionId: 'test-session',
          toolName: 'confirmer',
        })

        const events: ToolSessionEvent[] = []
        const eventStream = session.events()
        const sub = yield* eventStream

        yield* spawn(function* () {
          while (true) {
            const result = yield* sub.next()
            if (result.done) break
            events.push(result.value)
          }
        })

        // Simulate elicit request from worker
        workerTransport.send({
          type: 'elicit_request',
          elicitId: 'elicit_001',
          key: 'confirm',
          message: 'Proceed?',
          schema: { type: 'object' },
          lsn: 1,
        })

        yield* sleep(50)

        const elicitEvent = events.find(e => e.type === 'elicit_request') as ElicitRequestEvent
        expect(elicitEvent).toBeDefined()
        expect(elicitEvent.message).toBe('Proceed?')

        // Respond to elicit
        yield* session.respondToElicit('elicit_001', {
          action: 'accept',
          content: { confirmed: true },
        })

        yield* sleep(50)

        expect(yield* session.status()).toBe('running')

        // Simulate result
        workerTransport.send({
          type: 'result',
          result: { action: 'accept' },
          lsn: 2,
        })

        yield* sleep(50)
        expect(yield* session.status()).toBe('completed')

        hostTransport.close()
      })
    })
  })
})
