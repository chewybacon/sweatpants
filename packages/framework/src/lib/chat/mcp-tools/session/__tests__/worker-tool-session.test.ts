/**
 * Worker Tool Session Tests
 *
 * Tests the WorkerToolSession adapter that bridges worker transport
 * to the ToolSession interface.
 */

import { describe, it, expect } from 'vitest'
import { run, call, sleep } from 'effection'
import { createInProcessTransportPair } from '../worker-thread-transport.ts'
import { runWorker, createWorkerToolRegistry } from '../worker-runner.ts'
import { createWorkerToolSession } from '../worker-tool-session.ts'
import type { WorkerToolContext } from '../worker-types.ts'


describe('WorkerToolSession', () => {
  describe('simple tool', () => {
    it('creates a session and can check status', async () => {
      await run(function* () {
        const [hostTransport, workerTransport] = createInProcessTransportPair()

        // Create registry with simple echo tool
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

        // Start worker
        runWorker(workerTransport, registry)

        // Wait for worker to be ready
        yield* call(() => new Promise<void>((resolve) => setTimeout(resolve, 50)))

        // Create session
        const session = yield* createWorkerToolSession(hostTransport, {
          sessionId: 'test-session',
          toolName: 'echo',
          params: { message: 'hello' },
        })

        expect(session.id).toBe('test-session')
        expect(session.toolName).toBe('echo')

        // Wait for tool to complete
        yield* sleep(200)

        // Status should be completed
        const status = yield* session.status()
        expect(status).toBe('completed')

        hostTransport.close()
      })
    })
  })

  describe('sampling backchannel', () => {
    it('handles sample request and response through session interface', async () => {
      await run(function* () {
        const [hostTransport, workerTransport] = createInProcessTransportPair()

        // Create registry with sampling tool
        const registry = createWorkerToolRegistry([
          {
            name: 'greeter',
            *handler(params: unknown, ctx: WorkerToolContext) {
              const { name } = params as { name: string }
              ctx.log('info', `Generating greeting for ${name}`)

              const response = yield* ctx.sample(
                [{ role: 'user', content: `Say hello to ${name}` }],
                { maxTokens: 50 }
              )

              return { greeting: response.text }
            },
          },
        ])

        // Start worker
        runWorker(workerTransport, registry)
        yield* call(() => new Promise<void>((resolve) => setTimeout(resolve, 50)))

        // Create session
        const session = yield* createWorkerToolSession(hostTransport, {
          sessionId: 'test-session',
          toolName: 'greeter',
          params: { name: 'Alice' },
        })

        // Wait a bit for sample_request to arrive
        yield* sleep(100)

        // Status should be awaiting_sample
        let status = yield* session.status()
        expect(status).toBe('awaiting_sample')

        // Get the pending sample ID from the transport (hack for testing)
        // We need a way to get the sampleId - let's check the event buffer
        // For now, construct it based on the pattern
        const sampleId = 'test-session:sample:2' // lsn was 2 when sample was sent

        // Respond to sampling
        yield* session.respondToSample(sampleId, {
          text: 'Hello, Alice! Nice to meet you.',
          model: 'test-model',
          stopReason: 'endTurn',
        })

        // Wait for completion
        yield* sleep(200)

        // Status should be completed
        status = yield* session.status()
        expect(status).toBe('completed')

        hostTransport.close()
      })
    })
  })
})
