/**
 * Worker Runner
 *
 * This module runs inside a worker thread and executes tool generators.
 * It communicates with the host via the worker transport.
 *
 * ## Lifecycle
 *
 * 1. Worker starts, sends 'ready' message
 * 2. Host sends 'start' message with tool name and params
 * 3. Worker looks up tool in registry, executes handler
 * 4. When tool calls ctx.sample(), worker sends 'sample_request' and waits
 * 5. Host responds with 'sample_response', worker resumes
 * 6. Tool completes, worker sends 'result' and exits
 *
 * ## Signal Pattern
 *
 * The key insight is that Effection signals work perfectly for the
 * message → resume pattern when both sides are in the SAME process/scope.
 * By running the tool generator inside the worker with its own `run()`,
 * we have a single Effection scope where signals work as expected.
 *
 * @packageDocumentation
 */

import { run, createSignal, type Operation, type Signal } from 'effection'
import type {
  WorkerTransport,
  HostToWorkerMessage,
  StartMessage,
  WorkerToolRegistry,
  WorkerToolContext,
} from './worker-types.ts'
import type {
  Message,
  LogLevel,
  SampleResult,
  ElicitResult,
} from '../mcp-tool-types.ts'

// =============================================================================
// WORKER RUNNER
// =============================================================================

/**
 * Run a tool session worker.
 *
 * This is the entry point for the worker thread. It:
 * 1. Sends 'ready' to indicate it's listening
 * 2. Waits for 'start' message
 * 3. Executes the tool
 * 4. Sends result/error when done
 *
 * @param transport - The worker-side transport
 * @param registry - Registry of available tools
 */
export function runWorker(transport: WorkerTransport, registry: WorkerToolRegistry): void {
  // Signal indicates we're ready
  transport.send({ type: 'ready' })

  // Wait for start message
  const unsubscribe = transport.subscribe(async (message) => {
    if (message.type === 'start') {
      unsubscribe()
      await executeToolInWorker(transport, registry, message)
    }
  })
}

/**
 * Execute a tool inside the worker.
 *
 * @param transport - The worker-side transport
 * @param registry - Registry of available tools
 * @param startMessage - The start message with tool name and params
 */
async function executeToolInWorker(
  transport: WorkerTransport,
  registry: WorkerToolRegistry,
  startMessage: StartMessage
): Promise<void> {
  const { toolName, params, sessionId } = startMessage

  // Look up tool
  const tool = registry.get(toolName)
  if (!tool) {
    transport.send({
      type: 'error',
      name: 'ToolNotFound',
      message: `Tool not found: ${toolName}`,
      lsn: 1,
    })
    return
  }

  // Run the tool in an Effection scope
  await run(function* () {
    let lsn = 0
    const nextLsn = () => ++lsn

    // Signals for backchannel responses
    // These will be sent() from the message handler
    const sampleSignals = new Map<string, Signal<SampleResult, void>>()
    const elicitSignals = new Map<string, Signal<ElicitResult<unknown, unknown>, void>>()

    // Subscribe to incoming messages
    transport.subscribe((message: HostToWorkerMessage) => {
      switch (message.type) {
        case 'sample_response': {
          const signal = sampleSignals.get(message.sampleId)
          if (signal) {
            signal.send(message.response)
            sampleSignals.delete(message.sampleId)
          }
          break
        }
        case 'elicit_response': {
          const signal = elicitSignals.get(message.elicitId)
          if (signal) {
            signal.send(message.response)
            elicitSignals.delete(message.elicitId)
          }
          break
        }
        case 'cancel': {
          // TODO: Implement cancellation
          break
        }
      }
    })

    // Create tool context
    const ctx: WorkerToolContext = {
      log(level: LogLevel, message: string): void {
        transport.send({
          type: 'log',
          level,
          message,
          lsn: nextLsn(),
        })
      },

      progress(message: string, progressValue?: number): void {
        transport.send({
          type: 'progress',
          message,
          ...(progressValue !== undefined && { progress: progressValue }),
          lsn: nextLsn(),
        })
      },

      *sample(
        messages: Message[],
        options?: { systemPrompt?: string; maxTokens?: number }
      ): Operation<SampleResult> {
        const sampleId = `${sessionId}:sample:${nextLsn()}`

        // Create signal for response
        const responseSignal = createSignal<SampleResult, void>()
        sampleSignals.set(sampleId, responseSignal)

        // Send request
        transport.send({
          type: 'sample_request',
          sampleId,
          messages,
          ...(options?.systemPrompt !== undefined && { systemPrompt: options.systemPrompt }),
          ...(options?.maxTokens !== undefined && { maxTokens: options.maxTokens }),
          lsn: lsn,
        })

        // Wait for response
        const subscription = yield* responseSignal
        const result = yield* subscription.next()

        if (result.done) {
          throw new Error('Sample signal closed without response')
        }

        return result.value
      },

      *elicit<T>(
        key: string,
        options: { message: string; schema: Record<string, unknown> }
      ): Operation<ElicitResult<unknown, T>> {
        const elicitId = `${sessionId}:elicit:${nextLsn()}`

        // Create signal for response
        const responseSignal = createSignal<ElicitResult<unknown, unknown>, void>()
        elicitSignals.set(elicitId, responseSignal)

        // Send request
        transport.send({
          type: 'elicit_request',
          elicitId,
          key,
          message: options.message,
          schema: options.schema,
          lsn: lsn,
        })

        // Wait for response
        const subscription = yield* responseSignal
        const result = yield* subscription.next()

        if (result.done) {
          throw new Error('Elicit signal closed without response')
        }

        return result.value as ElicitResult<unknown, T>
      },
    }

    // Execute the tool
    try {
      const result = yield* tool.handler(params, ctx) as Operation<unknown>

      transport.send({
        type: 'result',
        result,
        lsn: nextLsn(),
      })
    } catch (error) {
      const err = error as Error
      transport.send({
        type: 'error',
        name: err.name,
        message: err.message,
        ...(err.stack !== undefined && { stack: err.stack }),
        lsn: nextLsn(),
      })
    }
  })
}

// =============================================================================
// SIMPLE TOOL REGISTRY
// =============================================================================

/**
 * Create a simple in-memory tool registry.
 *
 * @param tools - Array of tools to register
 * @returns The registry
 */
export function createWorkerToolRegistry(
  tools: Array<{ name: string; handler: (params: unknown, ctx: WorkerToolContext) => Generator<unknown, unknown, unknown> }>
): WorkerToolRegistry {
  const map = new Map<string, { name: string; handler: (params: unknown, ctx: WorkerToolContext) => Generator<unknown, unknown, unknown> }>()
  for (const tool of tools) {
    map.set(tool.name, tool)
  }

  return {
    get(name: string) {
      return map.get(name) ?? null
    },
    list() {
      return Array.from(map.keys())
    },
  }
}
