/**
 * Worker Runner (Core-Based)
 *
 * This module runs inside a worker thread and executes tool generators.
 * It uses @sweatpants/core's transport interface with a signal-based
 * implementation for request/response correlation.
 *
 * ## Architecture
 *
 * See `docs/adr-signal-based-transport.md` for the full design rationale.
 *
 * The worker-runner creates a `CorrelatedTransport` backed by Effection signals
 * instead of using core's `createCorrelation`. This handles the worker scenario
 * where responses can take arbitrarily long (user closes tab, returns later).
 *
 * ## Message Flow
 *
 * ```
 * Worker                                Host
 * ──────────────────────────────────────────────
 * createSignalCorrelatedTransport() ──►
 *
 * ctx.sample() ───► transport.request()
 *              ◄─── sample_response ◄─── LLM
 *
 * ctx.elicit() ──► transport.request()
 *              ◄── elicit_response ◄─── UI
 *
 * result ─────────────────────────────► host
 * ```
 *
 * @packageDocumentation
 */

import { run, type Operation, type Subscription } from 'effection'
import { TransportContext } from '@sweatpants/core'
import type { ElicitResponse, CorrelatedTransport } from '@sweatpants/core'
import type {
  WorkerTransport,
  StartMessage,
  WorkerToolRegistry,
  WorkerToolContext,
} from './worker-types.ts'
import type {
  Message,
  LogLevel,
  SampleResult,
  ElicitResult,
  McpMessage,
} from '../mcp-tool-types.ts'
import { createRawSampleExchange } from '../mcp-tool-types.ts'
import { createSignalCorrelatedTransport } from './signal-correlated-transport.ts'

// =============================================================================
// WORKER RUNNER
// =============================================================================

/**
 * Run a tool session worker using core's transport interface.
 *
 * This is the entry point for the worker thread. It:
 * 1. Sends 'ready' to indicate it's listening
 * 2. Waits for 'start' message
 * 3. Creates signal-based correlated transport
 * 4. Executes the tool with transport-backed context
 * 5. Sends result/error when done
 *
 * @param transport - The worker-side transport
 * @param registry - Registry of available tools
 */
export function runWorkerCore(transport: WorkerTransport, registry: WorkerToolRegistry): void {
  // Signal indicates we're ready
  transport.send({ type: 'ready' })

  // Wait for start message
  const unsubscribe = transport.subscribe(async (message) => {
    if (message.type === 'start') {
      unsubscribe()
      await executeToolWithCore(transport, registry, message)
    }
  })
}

/**
 * Execute a tool using core's transport infrastructure.
 *
 * @param transport - The worker-side transport
 * @param registry - Registry of available tools
 * @param startMessage - The start message with tool name and params
 */
async function executeToolWithCore(
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

  // Run the tool in an Effection scope with signal-based transport
  await run(function* () {
    let lsn = 0
    const nextLsn = () => ++lsn

    // Create signal-based correlated transport
    // This implements CorrelatedTransport using signals for correlation
    const correlatedTransport = yield* createSignalCorrelatedTransport(transport)

    // Set up transport context so operations can access it
    yield* TransportContext.set(correlatedTransport)

    // Create tool context using the correlated transport
    const ctx = createWorkerContextFromTransport(
      correlatedTransport,
      sessionId,
      nextLsn,
      transport
    )

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
// CONTEXT CREATION
// =============================================================================

/**
 * Create a WorkerToolContext backed by a CorrelatedTransport.
 *
 * This provides the same interface as the original worker-runner but
 * routes requests through core's transport infrastructure.
 */
function createWorkerContextFromTransport(
  transport: CorrelatedTransport,
  sessionId: string,
  nextLsn: () => number,
  rawTransport: WorkerTransport
): WorkerToolContext {
  let sampleSeq = 0
  let elicitSeq = 0

  return {
    log(level: LogLevel, message: string): void {
      // Log is fire-and-forget, use raw transport directly
      rawTransport.send({
        type: 'log',
        level,
        message,
        lsn: nextLsn(),
      })
    },

    progress(message: string, progressValue?: number): void {
      // Progress is fire-and-forget, use raw transport directly
      rawTransport.send({
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
      const sampleId = `${sessionId}:sample:${++sampleSeq}`

      // Send request through correlated transport
      const stream = transport.request<unknown, ElicitResponse>({
        id: sampleId,
        kind: 'elicit',
        type: 'sample',
        payload: {
          messages,
          systemPrompt: options?.systemPrompt,
          maxTokens: options?.maxTokens,
        },
      })

      const subscription: Subscription<unknown, ElicitResponse> = yield* stream

      // Consume until response
      let result = yield* subscription.next()
      while (!result.done) {
        result = yield* subscription.next()
      }

      const response = result.value

      if (response.status !== 'accepted') {
        throw new Error(`Sample request failed: ${response.status}`)
      }

      // Parse response content
      const rawResult = response.content as {
        text: string
        model?: string
        stopReason?: string
      }

      // Extract prompt text from last user message for exchange
      const lastUserMsg = [...messages].reverse().find(m => m.role === 'user')
      const promptText = typeof lastUserMsg?.content === 'string'
        ? lastUserMsg.content
        : ''

      // Construct exchange
      const exchange = createRawSampleExchange(promptText, rawResult.text)

      return { ...rawResult, exchange }
    },

    *elicit<T>(
      key: string,
      options: { message: string; schema: Record<string, unknown> }
    ): Operation<ElicitResult<unknown, T>> {
      const elicitId = `${sessionId}:elicit:${++elicitSeq}`

      // Send request through correlated transport
      const stream = transport.request<unknown, ElicitResponse>({
        id: elicitId,
        kind: 'elicit',
        type: 'elicit',
        payload: {
          key,
          message: options.message,
          schema: options.schema,
        },
      })

      const subscription: Subscription<unknown, ElicitResponse> = yield* stream

      // Consume until response
      let result = yield* subscription.next()
      while (!result.done) {
        result = yield* subscription.next()
      }

      const response = result.value

      if (response.status === 'accepted') {
        const parsedContent = response.content as T
        const toolUseId = `elicit_core_${elicitId}`

        // Build exchange using MCP format
        const request: McpMessage & { role: 'assistant' } = {
          role: 'assistant' as const,
          content: [{
            type: 'tool_use' as const,
            id: toolUseId,
            name: key,
            input: {},
          }],
        }
        const responseMsg: McpMessage & { role: 'user' } = {
          role: 'user' as const,
          content: [{
            type: 'tool_result' as const,
            toolUseId,
            content: [{ type: 'text' as const, text: JSON.stringify(parsedContent) }],
          }],
        }
        const exchange = {
          context: {} as unknown,
          request,
          response: responseMsg,
          messages: [request, responseMsg] as [McpMessage, McpMessage],
          withArguments(fn: (ctx: unknown) => Record<string, unknown>): [McpMessage, McpMessage] {
            const args = fn({})
            const requestWithArgs: McpMessage & { role: 'assistant' } = {
              role: 'assistant' as const,
              content: [{
                type: 'tool_use' as const,
                id: toolUseId,
                name: key,
                input: args,
              }],
            }
            return [requestWithArgs, responseMsg]
          },
        }

        return { action: 'accept' as const, content: parsedContent, exchange } as ElicitResult<unknown, T>
      }

      if (response.status === 'declined') {
        return { action: 'decline' }
      }

      return { action: 'cancel' }
    },
  }
}

// =============================================================================
// RE-EXPORT REGISTRY HELPER
// =============================================================================

export { createWorkerToolRegistry } from './worker-runner.ts'
