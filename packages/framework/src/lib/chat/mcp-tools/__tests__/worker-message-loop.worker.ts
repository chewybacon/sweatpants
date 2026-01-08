/**
 * Worker Thread - Tool Execution Runtime
 *
 * This worker runs its own Effection main() and:
 * 1. Listens for messages from the host via parentPort
 * 2. Runs tool executions that can block on sample/elicit
 * 3. Routes incoming responses to blocked operations via signals
 * 4. Handles clean shutdown via abort signal
 */

import { parentPort } from 'node:worker_threads'
import {
  main,
  createSignal,
  spawn,
  suspend,
  race,
  call,
  type Operation,
  type Signal,
} from 'effection'

import type { HostMessage, WorkerMessage } from './worker-message-loop.test'

// =============================================================================
// MESSAGE HANDLING
// =============================================================================

/** Send a message to the host */
function sendToHost(msg: WorkerMessage): void {
  parentPort?.postMessage(msg)
}

// =============================================================================
// TOOL CONTEXT (simplified version of MCP tool context)
// =============================================================================

/** Elicit result - matches MCP elicitation response */
type ElicitResult<T> =
  | { action: 'accept'; content: T }
  | { action: 'decline' }
  | { action: 'cancel' }

interface ToolContext {
  /** Request a sample from the host (blocks until response) */
  sample(prompt: string): Operation<{ text: string }>

  /** Request user input via elicitation (blocks until response) */
  elicit<T>(key: string, message: string, schema: unknown): Operation<ElicitResult<T>>
}

/** Pending sample request waiting for response */
interface PendingSample {
  sampleId: string
  resolve: (result: { text: string }) => void
}

/** Pending elicit request waiting for response */
interface PendingElicit {
  elicitId: string
  resolve: (result: ElicitResult<unknown>) => void
}

// =============================================================================
// TOOL REGISTRY (simplified tools for testing)
// =============================================================================

type ToolHandler = (params: unknown, ctx: ToolContext) => Operation<unknown>

const tools: Record<string, ToolHandler> = {
  /** Simple tool that doesn't need sampling */
  simple: function* (params) {
    const { value } = params as { value: number }
    return { doubled: value * 2 }
  },

  /** Tool that requests a sample */
  greeter: function* (params, ctx) {
    const { name } = params as { name: string }
    console.log(`[Tool:greeter] Requesting sample for ${name}...`)
    const response = yield* ctx.sample(`Generate a greeting for ${name}`)
    console.log(`[Tool:greeter] Got response: ${response.text}`)
    return { greeting: response.text }
  },

  /** Tool that makes multiple sample requests */
  multi_sample: function* (params, ctx) {
    const { count } = params as { count: number }
    const responses: string[] = []

    for (let i = 0; i < count; i++) {
      const response = yield* ctx.sample(`Request ${i + 1}`)
      responses.push(response.text)
    }

    return { responses }
  },

  /** Slow tool for testing abort */
  slow: function* () {
    // Simulate long-running work
    yield* suspend()
    return { done: true }
  },

  /** Tool that uses elicit for confirmation */
  confirm_action: function* (params, ctx) {
    const { action } = params as { action: string }

    const result = yield* ctx.elicit<{ confirmed: boolean }>(
      'confirm',
      `Are you sure you want to ${action}?`,
      { type: 'object', properties: { confirmed: { type: 'boolean' } } }
    )

    if (result.action === 'accept') {
      return { performed: true, action }
    } else {
      return { performed: false, reason: 'User declined' }
    }
  },

  /** Realistic tool: sample for greeting, then elicit for confirmation */
  greet_with_confirm: function* (params, ctx) {
    const { name, style } = params as { name: string; style: string }

    // Step 1: Generate greeting via sampling
    console.log(`[Tool:greet_with_confirm] Requesting sample for ${name} (${style})...`)
    const sampleResponse = yield* ctx.sample(
      `Generate a ${style} greeting for someone named "${name}". Keep it to 1-2 sentences.`
    )
    const generatedGreeting = sampleResponse.text
    console.log(`[Tool:greet_with_confirm] Got generated greeting: ${generatedGreeting}`)

    // Step 2: Ask user to approve/edit
    console.log(`[Tool:greet_with_confirm] Requesting user approval...`)
    const elicitResult = yield* ctx.elicit<{ approved: boolean; edited?: boolean; newGreeting?: string }>(
      'approve_greeting',
      `Generated greeting: "${generatedGreeting}"\n\nDo you approve this greeting?`,
      {
        type: 'object',
        properties: {
          approved: { type: 'boolean' },
          edited: { type: 'boolean' },
          newGreeting: { type: 'string' },
        },
      }
    )
    console.log(`[Tool:greet_with_confirm] Got elicit result:`, elicitResult)

    if (elicitResult.action !== 'accept') {
      return { greeting: null, cancelled: true }
    }

    const content = elicitResult.content
    if (content.edited && content.newGreeting) {
      return { greeting: content.newGreeting, wasEdited: true }
    }

    return { greeting: generatedGreeting, wasEdited: false }
  },
}

// =============================================================================
// WORKER MAIN
// =============================================================================

await main(function* () {
  console.log('[Worker] Starting...')

  // Signal for abort requests
  const abortSignal: Signal<void, void> = createSignal<void, void>()

  // Map of pending sample requests
  const pendingSamples = new Map<string, PendingSample>()
  let sampleIdCounter = 0

  // Map of pending elicit requests
  const pendingElicits = new Map<string, PendingElicit>()
  let elicitIdCounter = 0

  // Signal for incoming messages (so we can yield* on it)
  const messageSignal: Signal<HostMessage, void> = createSignal<HostMessage, void>()

  // Bridge parentPort.onmessage -> Effection signal
  parentPort?.on('message', (msg: HostMessage) => {
    console.log('[Worker] Received message:', msg.type)

    if (msg.type === 'abort') {
      // Signal abort
      abortSignal.send()
      return
    }

    if (msg.type === 'sample_response') {
      // Route to pending sample - this resolves the promise that sample() is waiting on
      const pending = pendingSamples.get(msg.sampleId)
      if (pending) {
        console.log(`[Worker] Routing sample_response to pending sampleId=${msg.sampleId}`)
        pending.resolve(msg.result)
        pendingSamples.delete(msg.sampleId)
      } else {
        console.log(`[Worker] WARNING: No pending sample for sampleId=${msg.sampleId}`)
      }
      return
    }

    if (msg.type === 'elicit_response') {
      // Route to pending elicit - this resolves the promise that elicit() is waiting on
      const pending = pendingElicits.get(msg.elicitId)
      if (pending) {
        console.log(`[Worker] Routing elicit_response to pending elicitId=${msg.elicitId}`)
        const result: ElicitResult<unknown> =
          msg.action === 'accept'
            ? { action: 'accept', content: msg.content }
            : msg.action === 'decline'
              ? { action: 'decline' }
              : { action: 'cancel' }
        pending.resolve(result)
        pendingElicits.delete(msg.elicitId)
      } else {
        console.log(`[Worker] WARNING: No pending elicit for elicitId=${msg.elicitId}`)
      }
      return
    }

    // Other messages go to the message signal
    messageSignal.send(msg)
  })

  // Create tool context factory
  function createToolContext(): ToolContext {
    return {
      *sample(prompt: string): Operation<{ text: string }> {
        const sampleId = `sample_${++sampleIdCounter}`
        console.log(`[Context] sample() called, sampleId=${sampleId}`)

        // Create promise for the response
        let resolve: (result: { text: string }) => void
        const responsePromise = new Promise<{ text: string }>((r) => {
          resolve = r
        })

        // Register pending
        pendingSamples.set(sampleId, { sampleId, resolve: resolve! })

        // Send request to host
        sendToHost({ type: 'sample_request', sampleId, prompt })
        console.log(`[Context] sample() waiting for response...`)

        // Wait for response using call() to convert Promise -> Operation
        // This is where the generator suspends until the promise resolves
        const result = yield* call(() => responsePromise)
        console.log(`[Context] sample() resumed with result`)

        return result
      },

      *elicit<T>(key: string, message: string, schema: unknown): Operation<ElicitResult<T>> {
        const elicitId = `elicit_${++elicitIdCounter}`
        console.log(`[Context] elicit() called, elicitId=${elicitId}, key=${key}`)

        // Create promise for the response
        let resolve: (result: ElicitResult<T>) => void
        const responsePromise = new Promise<ElicitResult<T>>((r) => {
          resolve = r as (result: ElicitResult<T>) => void
        })

        // Register pending
        pendingElicits.set(elicitId, { elicitId, resolve: resolve! as (result: ElicitResult<unknown>) => void })

        // Send request to host
        sendToHost({ type: 'elicit_request', elicitId, key, message, schema })
        console.log(`[Context] elicit() waiting for response...`)

        // Wait for response
        const result = yield* call(() => responsePromise)
        console.log(`[Context] elicit() resumed with result:`, result.action)

        return result
      },
    }
  }

  // Message processing loop
  yield* spawn(function* () {
    const subscription = yield* messageSignal

    while (true) {
      // Race between next message and abort
      const result = yield* race([
        subscription.next(),
        (function* (): Operation<'aborted'> {
          const sub = yield* abortSignal
          yield* sub.next()
          return 'aborted'
        })(),
      ])

      if (result === 'aborted') {
        console.log('[Worker] Abort received in message loop')
        break
      }

      if (result.done) {
        console.log('[Worker] Message signal closed')
        break
      }

      const msg = result.value

      if (msg.type === 'run_tool') {
        // Spawn tool execution
        yield* spawn(function* () {
          try {
            const tool = tools[msg.toolName]
            if (!tool) {
              sendToHost({ type: 'tool_error', error: `Unknown tool: ${msg.toolName}` })
              return
            }

            const ctx = createToolContext()

            // Race tool execution against abort
            const toolResult = yield* race([
              (function* (): Operation<{ type: 'result'; value: unknown }> {
                const value = yield* tool(msg.params, ctx)
                return { type: 'result', value }
              })(),
              (function* (): Operation<{ type: 'aborted' }> {
                const sub = yield* abortSignal
                yield* sub.next()
                return { type: 'aborted' }
              })(),
            ])

            if (toolResult.type === 'aborted') {
              console.log('[Worker] Tool aborted')
              return
            }

            sendToHost({ type: 'tool_result', result: toolResult.value })
          } catch (error) {
            sendToHost({
              type: 'tool_error',
              error: error instanceof Error ? error.message : String(error),
            })
          }
        })
      }
    }
  })

  // Signal ready
  sendToHost({ type: 'ready' })

  // Wait for abort signal
  const abortSub = yield* abortSignal
  yield* abortSub.next()

  console.log('[Worker] Shutting down...')

  // Clean up any pending samples
  for (const pending of pendingSamples.values()) {
    // Reject pending samples? Or just let them be cleaned up?
  }

  sendToHost({ type: 'shutdown_complete' })
  console.log('[Worker] Shutdown complete')
})
