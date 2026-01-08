/**
 * Worker Message Loop Pattern Test
 *
 * This test proves the core pattern for cross-thread communication:
 * 1. Worker thread runs its own Effection main()
 * 2. Tool execution can block waiting for sample/elicit responses
 * 3. Host sends messages via postMessage
 * 4. Worker's message loop receives and routes to blocked operations
 * 5. Host can cleanly shut down the worker
 *
 * This is the foundation for the MCP durable runtime.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Worker } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// =============================================================================
// MESSAGE TYPES
// =============================================================================

/** Messages from host -> worker */
export type HostMessage =
  | { type: 'run_tool'; toolName: string; params: unknown }
  | { type: 'sample_response'; sampleId: string; result: { text: string } }
  | { type: 'elicit_response'; elicitId: string; action: 'accept' | 'decline' | 'cancel'; content?: unknown }
  | { type: 'abort' }

/** Messages from worker -> host */
export type WorkerMessage =
  | { type: 'ready' }
  | { type: 'sample_request'; sampleId: string; prompt: string }
  | { type: 'elicit_request'; elicitId: string; key: string; message: string; schema: unknown }
  | { type: 'tool_result'; result: unknown }
  | { type: 'tool_error'; error: string }
  | { type: 'shutdown_complete' }

// =============================================================================
// SIMPLE HOST-SIDE WRAPPER
// =============================================================================

/**
 * Simple wrapper around Worker for test convenience.
 * In production this would be the Hydra-style pool manager.
 */
class TestWorkerHost {
  private worker: Worker
  private messageHandlers: ((msg: WorkerMessage) => void)[] = []
  private readyPromise: Promise<void>
  private readyResolve!: () => void

  constructor(workerPath: string) {
    this.readyPromise = new Promise((resolve) => {
      this.readyResolve = resolve
    })

    this.worker = new Worker(workerPath)

    this.worker.on('message', (msg: WorkerMessage) => {
      if (msg.type === 'ready') {
        this.readyResolve()
      }
      for (const handler of this.messageHandlers) {
        handler(msg)
      }
    })

    this.worker.on('error', (err) => {
      console.error('[Host] Worker error:', err)
    })
  }

  async waitForReady(): Promise<void> {
    return this.readyPromise
  }

  send(msg: HostMessage): void {
    this.worker.postMessage(msg)
  }

  onMessage(handler: (msg: WorkerMessage) => void): void {
    this.messageHandlers.push(handler)
  }

  /** Wait for a specific message type */
  waitForMessage<T extends WorkerMessage['type']>(
    type: T,
    timeout = 5000
  ): Promise<Extract<WorkerMessage, { type: T }>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Timeout waiting for message type: ${type}`))
      }, timeout)

      const handler = (msg: WorkerMessage) => {
        if (msg.type === type) {
          clearTimeout(timer)
          this.messageHandlers = this.messageHandlers.filter((h) => h !== handler)
          resolve(msg as Extract<WorkerMessage, { type: T }>)
        }
      }
      this.messageHandlers.push(handler)
    })
  }

  async terminate(): Promise<void> {
    await this.worker.terminate()
  }
}

// =============================================================================
// TESTS
// =============================================================================

describe('Worker Message Loop Pattern', () => {
  let host: TestWorkerHost

  // Get path to worker file (same directory)
  const __filename = fileURLToPath(import.meta.url)
  const __dirname = dirname(__filename)
  const workerPath = join(__dirname, 'worker-message-loop.worker.ts')

  beforeEach(async () => {
    host = new TestWorkerHost(workerPath)
    await host.waitForReady()
  })

  afterEach(async () => {
    // Clean shutdown
    host.send({ type: 'abort' })
    try {
      await host.waitForMessage('shutdown_complete', 2000)
    } catch {
      // Force terminate if clean shutdown fails
    }
    await host.terminate()
  })

  it('worker starts and signals ready', async () => {
    // The beforeEach already waited for ready, so if we get here it worked
    expect(true).toBe(true)
  })

  it('tool runs to completion without blocking', async () => {
    // Run a simple tool that doesn't need sample/elicit
    host.send({
      type: 'run_tool',
      toolName: 'simple',
      params: { value: 42 },
    })

    const result = await host.waitForMessage('tool_result')
    expect(result.result).toEqual({ doubled: 84 })
  })

  it('tool blocks on sample, receives response, continues', async () => {
    // Run a tool that needs sampling
    host.send({
      type: 'run_tool',
      toolName: 'greeter',
      params: { name: 'Alice' },
    })

    // Wait for sample request
    const sampleReq = await host.waitForMessage('sample_request')
    expect(sampleReq.prompt).toContain('Alice')

    // Send sample response
    host.send({
      type: 'sample_response',
      sampleId: sampleReq.sampleId,
      result: { text: 'Hello Alice, welcome!' },
    })

    // Tool should complete with the greeting
    const result = await host.waitForMessage('tool_result')
    expect(result.result).toEqual({ greeting: 'Hello Alice, welcome!' })
  })

  it('tool can make multiple sample calls', async () => {
    host.send({
      type: 'run_tool',
      toolName: 'multi_sample',
      params: { count: 3 },
    })

    // Handle 3 sample requests
    for (let i = 0; i < 3; i++) {
      const sampleReq = await host.waitForMessage('sample_request')
      host.send({
        type: 'sample_response',
        sampleId: sampleReq.sampleId,
        result: { text: `Response ${i + 1}` },
      })
    }

    const result = await host.waitForMessage('tool_result')
    expect(result.result).toEqual({
      responses: ['Response 1', 'Response 2', 'Response 3'],
    })
  })

  it('abort signal cleanly shuts down worker', async () => {
    // Start a long-running tool
    host.send({
      type: 'run_tool',
      toolName: 'slow',
      params: {},
    })

    // Give it a moment to start
    await new Promise((r) => setTimeout(r, 100))

    // Abort
    host.send({ type: 'abort' })

    // Should get clean shutdown
    const shutdown = await host.waitForMessage('shutdown_complete', 2000)
    expect(shutdown.type).toBe('shutdown_complete')
  })

  it('abort during blocked sample cleanly shuts down', async () => {
    host.send({
      type: 'run_tool',
      toolName: 'greeter',
      params: { name: 'Bob' },
    })

    // Wait for it to block on sample
    await host.waitForMessage('sample_request')

    // Abort instead of responding
    host.send({ type: 'abort' })

    // Should get clean shutdown
    const shutdown = await host.waitForMessage('shutdown_complete', 2000)
    expect(shutdown.type).toBe('shutdown_complete')
  })

  it('tool can use elicit to get user confirmation', async () => {
    host.send({
      type: 'run_tool',
      toolName: 'confirm_action',
      params: { action: 'delete files' },
    })

    // Wait for elicit request
    const elicitReq = await host.waitForMessage('elicit_request')
    expect(elicitReq.key).toBe('confirm')
    expect(elicitReq.message).toContain('delete files')

    // Send acceptance
    host.send({
      type: 'elicit_response',
      elicitId: elicitReq.elicitId,
      action: 'accept',
      content: { confirmed: true },
    })

    // Tool should complete
    const result = await host.waitForMessage('tool_result')
    expect(result.result).toEqual({ performed: true, action: 'delete files' })
  })

  it('tool handles elicit decline gracefully', async () => {
    host.send({
      type: 'run_tool',
      toolName: 'confirm_action',
      params: { action: 'format disk' },
    })

    const elicitReq = await host.waitForMessage('elicit_request')

    // Decline
    host.send({
      type: 'elicit_response',
      elicitId: elicitReq.elicitId,
      action: 'decline',
    })

    const result = await host.waitForMessage('tool_result')
    expect(result.result).toEqual({ performed: false, reason: 'User declined' })
  })

  it('realistic tool: sample for greeting then elicit for confirmation', async () => {
    // This simulates the actual greet tool flow:
    // 1. Call LLM to generate greeting (sample)
    // 2. Ask user to confirm/edit (elicit)
    // 3. Return final result

    host.send({
      type: 'run_tool',
      toolName: 'greet_with_confirm',
      params: { name: 'Alice', style: 'formal' },
    })

    // First: sample request for greeting generation
    const sampleReq = await host.waitForMessage('sample_request')
    expect(sampleReq.prompt).toContain('Alice')
    expect(sampleReq.prompt).toContain('formal')

    host.send({
      type: 'sample_response',
      sampleId: sampleReq.sampleId,
      result: { text: 'Dear Alice, I hope this message finds you well.' },
    })

    // Second: elicit request for user confirmation
    const elicitReq = await host.waitForMessage('elicit_request')
    expect(elicitReq.key).toBe('approve_greeting')
    expect(elicitReq.message).toContain('Dear Alice')

    host.send({
      type: 'elicit_response',
      elicitId: elicitReq.elicitId,
      action: 'accept',
      content: { approved: true, edited: false },
    })

    // Final result
    const result = await host.waitForMessage('tool_result')
    expect(result.result).toEqual({
      greeting: 'Dear Alice, I hope this message finds you well.',
      wasEdited: false,
    })
  })

  it('realistic tool: user edits the generated greeting', async () => {
    host.send({
      type: 'run_tool',
      toolName: 'greet_with_confirm',
      params: { name: 'Bob', style: 'casual' },
    })

    // Sample
    const sampleReq = await host.waitForMessage('sample_request')
    host.send({
      type: 'sample_response',
      sampleId: sampleReq.sampleId,
      result: { text: 'Hey Bob, what\'s up!' },
    })

    // Elicit - user edits
    const elicitReq = await host.waitForMessage('elicit_request')
    host.send({
      type: 'elicit_response',
      elicitId: elicitReq.elicitId,
      action: 'accept',
      content: { approved: true, edited: true, newGreeting: 'Hello Bob, nice to meet you!' },
    })

    const result = await host.waitForMessage('tool_result')
    expect(result.result).toEqual({
      greeting: 'Hello Bob, nice to meet you!',
      wasEdited: true,
    })
  })
})
