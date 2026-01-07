/**
 * Worker Runner Tests
 *
 * Tests the worker runner with in-process transports to verify
 * the message passing and generator execution work correctly.
 */

import { describe, it, expect } from 'vitest'
import { createInProcessTransportPair } from '../worker-thread-transport'
import { runWorker, createWorkerToolRegistry } from '../worker-runner'
import type {
  WorkerToHostMessage,
  WorkerToolContext,
} from '../worker-types'

describe('WorkerRunner', () => {
  describe('simple tool (no backchannel)', () => {
    it('executes a simple tool and returns result', async () => {
      const [hostTransport, workerTransport] = createInProcessTransportPair()

      // Create a simple echo tool
      const registry = createWorkerToolRegistry([
        {
          name: 'echo',
          *handler(params: unknown, _ctx: WorkerToolContext) {
            const { message } = params as { message: string }
            return { echoed: message }
          },
        },
      ])

      // Collect messages from worker
      const messages: WorkerToHostMessage[] = []
      hostTransport.subscribe((msg) => messages.push(msg))

      // Start worker (will send 'ready')
      runWorker(workerTransport, registry)

      // Wait for ready
      await waitForMessage(messages, 'ready')

      // Send start
      hostTransport.send({
        type: 'start',
        toolName: 'echo',
        params: { message: 'hello' },
        sessionId: 'test-session',
      })

      // Wait for result
      const result = await waitForMessage(messages, 'result')

      expect(result.type).toBe('result')
      expect((result as { result: unknown }).result).toEqual({ echoed: 'hello' })

      hostTransport.close()
    })

    it('returns error for unknown tool', async () => {
      const [hostTransport, workerTransport] = createInProcessTransportPair()

      const registry = createWorkerToolRegistry([])
      const messages: WorkerToHostMessage[] = []
      hostTransport.subscribe((msg) => messages.push(msg))

      runWorker(workerTransport, registry)
      await waitForMessage(messages, 'ready')

      hostTransport.send({
        type: 'start',
        toolName: 'nonexistent',
        params: {},
        sessionId: 'test-session',
      })

      const error = await waitForMessage(messages, 'error')

      expect(error.type).toBe('error')
      expect((error as { message: string }).message).toContain('nonexistent')

      hostTransport.close()
    })
  })

  describe('tool with logging', () => {
    it('receives log messages from tool', async () => {
      const [hostTransport, workerTransport] = createInProcessTransportPair()

      const registry = createWorkerToolRegistry([
        {
          name: 'logger',
          *handler(_params: unknown, ctx: WorkerToolContext) {
            ctx.log('info', 'Starting...')
            ctx.log('debug', 'Processing...')
            ctx.log('info', 'Done!')
            return { status: 'ok' }
          },
        },
      ])

      const messages: WorkerToHostMessage[] = []
      hostTransport.subscribe((msg) => messages.push(msg))

      runWorker(workerTransport, registry)
      await waitForMessage(messages, 'ready')

      hostTransport.send({
        type: 'start',
        toolName: 'logger',
        params: {},
        sessionId: 'test-session',
      })

      await waitForMessage(messages, 'result')

      const logs = messages.filter((m) => m.type === 'log')
      expect(logs).toHaveLength(3)
      expect(logs.map((l) => (l as { message: string }).message)).toEqual([
        'Starting...',
        'Processing...',
        'Done!',
      ])

      hostTransport.close()
    })
  })

  describe('tool with sampling backchannel', () => {
    it('pauses for sampling and resumes with response', async () => {
      const [hostTransport, workerTransport] = createInProcessTransportPair()

      const registry = createWorkerToolRegistry([
        {
          name: 'greeter',
          *handler(params: unknown, ctx: WorkerToolContext) {
            const { name } = params as { name: string }

            // Request sampling
            const response = yield* ctx.sample(
              [{ role: 'user', content: `Generate a greeting for ${name}` }],
              { maxTokens: 100 }
            )

            return {
              name,
              greeting: response.text,
              model: response.model,
            }
          },
        },
      ])

      const messages: WorkerToHostMessage[] = []
      hostTransport.subscribe((msg) => {
        messages.push(msg)

        // Auto-respond to sampling requests
        if (msg.type === 'sample_request') {
          hostTransport.send({
            type: 'sample_response',
            sampleId: msg.sampleId,
            response: {
              text: 'Hello, Alice!',
              model: 'test-model',
              stopReason: 'endTurn',
            },
          })
        }
      })

      runWorker(workerTransport, registry)
      await waitForMessage(messages, 'ready')

      hostTransport.send({
        type: 'start',
        toolName: 'greeter',
        params: { name: 'Alice' },
        sessionId: 'test-session',
      })

      const result = await waitForMessage(messages, 'result')

      expect(result.type).toBe('result')
      expect((result as { result: unknown }).result).toEqual({
        name: 'Alice',
        greeting: 'Hello, Alice!',
        model: 'test-model',
      })

      // Verify we got a sample request
      const sampleRequest = messages.find((m) => m.type === 'sample_request')
      expect(sampleRequest).toBeDefined()

      hostTransport.close()
    })
  })

  describe('tool with elicitation backchannel', () => {
    it('pauses for elicitation and resumes with response', async () => {
      const [hostTransport, workerTransport] = createInProcessTransportPair()

      const registry = createWorkerToolRegistry([
        {
          name: 'confirmer',
          *handler(params: unknown, ctx: WorkerToolContext) {
            const { action } = params as { action: string }

            // Request elicitation
            const response = yield* ctx.elicit<{ confirmed: boolean }>('confirm', {
              message: `Are you sure you want to ${action}?`,
              schema: { type: 'object', properties: { confirmed: { type: 'boolean' } } },
            })

            if (response.action === 'cancel' || response.action === 'decline') {
              return { cancelled: true }
            }

            return {
              action,
              confirmed: response.content.confirmed,
            }
          },
        },
      ])

      const messages: WorkerToHostMessage[] = []
      hostTransport.subscribe((msg) => {
        messages.push(msg)

        // Auto-respond to elicit requests
        if (msg.type === 'elicit_request') {
          hostTransport.send({
            type: 'elicit_response',
            elicitId: msg.elicitId,
            response: {
              action: 'accept',
              content: { confirmed: true },
            },
          })
        }
      })

      runWorker(workerTransport, registry)
      await waitForMessage(messages, 'ready')

      hostTransport.send({
        type: 'start',
        toolName: 'confirmer',
        params: { action: 'delete files' },
        sessionId: 'test-session',
      })

      const result = await waitForMessage(messages, 'result')

      expect(result.type).toBe('result')
      expect((result as { result: unknown }).result).toEqual({
        action: 'delete files',
        confirmed: true,
      })

      hostTransport.close()
    })
  })
})

// Helper to wait for a specific message type
async function waitForMessage(
  messages: WorkerToHostMessage[],
  type: WorkerToHostMessage['type'],
  timeoutMs = 5000
): Promise<WorkerToHostMessage> {
  const start = Date.now()

  while (Date.now() - start < timeoutMs) {
    const msg = messages.find((m) => m.type === type)
    if (msg) return msg

    // Wait a tick
    await new Promise((resolve) => setTimeout(resolve, 10))
  }

  throw new Error(`Timeout waiting for message type: ${type}`)
}
