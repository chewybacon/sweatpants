/**
 * Worker-based Tool Session
 *
 * Adapts @sweatpants/core's worker transport to the ToolSession interface.
 * This allows the existing MCP handler infrastructure to work with tools
 * running in isolated worker threads.
 *
 * ## Architecture
 *
 * ```
 * MCP Handler
 *   │
 *   │ ToolSession interface
 *   ▼
 * WorkerToolSession (this module)
 *   │
 *   │ @effectionx/worker via @sweatpants/core
 *   ▼
 * Worker (running tool generator via runWorker)
 * ```
 *
 * ## Communication Model
 *
 * Uses @sweatpants/core's createWorkerOperative which handles:
 * - Worker lifecycle (spawn, cleanup on scope exit)
 * - Bidirectional communication (worker sends requests, host responds)
 * - Final result collection
 *
 * @packageDocumentation
 */

import {
  type Operation,
  type Stream,
  type Subscription,
  resource,
  createChannel,
  spawn,
} from 'effection'
import {
  createWorkerOperative,
  type WorkerRequest,
  type WorkerResponse,
  type WorkerResult,
  type WorkerProgressMessage,
  type ForEachContext,
} from '@sweatpants/core/transport/worker'
import type {
  ToolSession,
  ToolSessionStatus,
  ToolSessionEvent,
  RawSampleResult,
} from './types.ts'
import type { RawElicitResult, Message } from '../mcp-tool-types.ts'
import type { McpWorkerInitData } from './worker-types.ts'

// =============================================================================
// WORKER TOOL SESSION
// =============================================================================

/**
 * Options for creating a worker tool session.
 */
export interface WorkerToolSessionOptions {
  /** Session ID */
  sessionId: string
  /** Tool name */
  toolName: string
  /** Tool parameters */
  params: unknown
  /** URL to the worker script */
  workerUrl: string | URL
  /** Optional system prompt */
  systemPrompt?: string
  /** Optional parent messages */
  parentMessages?: Message[]
}

/**
 * Handler for sample requests from the worker.
 * Called when the worker tool calls ctx.sample().
 */
export type SampleRequestHandler = (
  request: {
    sampleId: string
    messages: Message[]
    systemPrompt?: string
    maxTokens?: number
    tools?: Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }>
    toolChoice?: 'auto' | 'none' | 'required' | { type: 'tool'; name: string }
    schema?: Record<string, unknown>
  },
  ctx: ForEachContext<WorkerProgressMessage>
) => Operation<RawSampleResult>

/**
 * Handler for elicit requests from the worker.
 * Called when the worker tool calls ctx.elicit().
 */
export type ElicitRequestHandler = (
  request: {
    elicitId: string
    key: string
    message: string
    schema: Record<string, unknown>
  },
  ctx: ForEachContext<WorkerProgressMessage>
) => Operation<RawElicitResult<unknown>>

/**
 * Create a ToolSession backed by a web worker.
 *
 * This resource:
 * 1. Spawns a worker with the tool to execute
 * 2. Handles requests from the worker (sample/elicit) via callbacks
 * 3. Exposes the ToolSession interface for the host to interact
 *
 * @param options - Session configuration
 * @param onSampleRequest - Handler for sample requests
 * @param onElicitRequest - Handler for elicit requests
 * @returns A ToolSession resource
 */
export function createWorkerToolSession(
  options: WorkerToolSessionOptions,
  onSampleRequest: SampleRequestHandler,
  onElicitRequest: ElicitRequestHandler
): Operation<ToolSession> {
  return resource<ToolSession>(function* (provide) {
    const { sessionId, toolName, params, workerUrl, systemPrompt, parentMessages } = options

    // State
    let status: ToolSessionStatus = 'initializing'
    let lsn = 0
    const eventBuffer: ToolSessionEvent[] = []

    // Channel for streaming events to subscribers
    const eventChannel = createChannel<ToolSessionEvent, void>()

    // Pending requests (for respondToSample/respondToElicit)
    const pendingSamples = new Map<string, {
      resolve: (response: RawSampleResult) => void
    }>()
    const pendingElicits = new Map<string, {
      resolve: (response: RawElicitResult<unknown>) => void
    }>()

    // Helper to emit events
    // Using a more permissive input type to avoid TypeScript's excess property checking issues
    // with discriminated unions - the 'type' field discriminates at runtime
    function* emitEvent(
      event: { type: ToolSessionEvent['type'] } & Record<string, unknown>
    ): Operation<void> {
      const fullEvent: ToolSessionEvent = {
        ...event,
        lsn: ++lsn,
        timestamp: Date.now(),
      } as ToolSessionEvent

      eventBuffer.push(fullEvent)

      // Update status based on event type
      switch (fullEvent.type) {
        case 'sample_request':
          status = 'awaiting_sample'
          break
        case 'elicit_request':
          status = 'awaiting_elicit'
          break
        case 'result':
          status = 'completed'
          break
        case 'error':
          status = 'failed'
          break
        case 'cancelled':
          status = 'cancelled'
          break
        case 'progress':
        case 'log':
          if (status === 'initializing') {
            status = 'running'
          }
          break
      }

      // Send to channel (for subscribers)
      yield* eventChannel.send(fullEvent)
    }

    // Build init data for the worker
    const initData: McpWorkerInitData = {
      toolName,
      params,
      sessionId,
      ...(systemPrompt !== undefined && { systemPrompt }),
      ...(parentMessages !== undefined && { parentMessages }),
    }

    // Create the worker using core's createWorkerOperative
    // (host acts as operative, handling requests from the worker which acts as principal)
    const { result: workerResult } = yield* createWorkerOperative<unknown>({
      workerUrl,
      initData: initData as unknown as Parameters<typeof createWorkerOperative>[0]['initData'],
      requestHandler: function* (request: WorkerRequest, ctx: ForEachContext<WorkerProgressMessage>): Operation<WorkerResponse> {
        const requestId = request.id

        if (request.type === 'sample') {
          const sampleId = requestId

          // Emit sample request event
          yield* emitEvent({
            type: 'sample_request',
            sampleId,
            messages: request.messages.map(m => ({
              role: m.role,
              content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
            })),
            ...(request.systemPrompt !== undefined && { systemPrompt: request.systemPrompt }),
            ...(request.maxTokens !== undefined && { maxTokens: request.maxTokens }),
            ...(request.tools !== undefined && { tools: request.tools }),
            ...(request.toolChoice !== undefined && { toolChoice: request.toolChoice }),
            ...(request.schema !== undefined && { schema: request.schema }),
          })

          // Call the sample handler (this may call respondToSample later)
          const rawResult = yield* onSampleRequest(
            {
              sampleId,
              messages: request.messages.map(m => ({
                role: m.role,
                content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
              })),
              ...(request.systemPrompt !== undefined && { systemPrompt: request.systemPrompt }),
              ...(request.maxTokens !== undefined && { maxTokens: request.maxTokens }),
              ...(request.tools !== undefined && { tools: request.tools }),
              ...(request.toolChoice !== undefined && { toolChoice: request.toolChoice }),
              ...(request.schema !== undefined && { schema: request.schema }),
            },
            ctx
          )

          // Mark as running again
          status = 'running'

          // Build response
          const response: WorkerResponse = {
            id: requestId,
            type: 'sample',
            status: 'accepted',
            text: rawResult.text,
            ...(rawResult.model !== undefined && { model: rawResult.model }),
            ...(rawResult.stopReason !== undefined && { stopReason: rawResult.stopReason }),
            ...('parsed' in rawResult && rawResult.parsed !== undefined && { parsed: rawResult.parsed }),
            ...('parseError' in rawResult && rawResult.parseError !== undefined && { parseError: rawResult.parseError }),
            ...('toolCalls' in rawResult && rawResult.toolCalls !== undefined && { toolCalls: rawResult.toolCalls }),
          }

          return response
        }

        if (request.type === 'elicit') {
          const elicitId = requestId

          // Emit elicit request event
          yield* emitEvent({
            type: 'elicit_request',
            elicitId,
            key: request.key,
            message: request.message,
            schema: request.schema,
          })

          // Call the elicit handler
          const rawResult = yield* onElicitRequest(
            {
              elicitId,
              key: request.key,
              message: request.message,
              schema: request.schema,
            },
            ctx
          )

          // Mark as running again
          status = 'running'

          // Map action to status
          const responseStatus = rawResult.action === 'accept' ? 'accepted'
            : rawResult.action === 'decline' ? 'declined'
            : 'cancelled'

          // Build response
          const response: WorkerResponse = {
            id: requestId,
            type: 'elicit',
            status: responseStatus,
            ...(rawResult.action === 'accept' && { content: rawResult.content }),
          }

          return response
        }

        throw new Error(`Unknown request type: ${(request as WorkerRequest).type}`)
      },
    })

    // Mark as running
    status = 'running'

    // Spawn a task to wait for the worker result
    yield* spawn(function* () {
      try {
        const result: WorkerResult<unknown> = yield* workerResult

          if (result.type === 'success') {
            yield* emitEvent({
              type: 'result',
              result: result.value,
            })
          } else if (result.type === 'error') {
            yield* emitEvent({
              type: 'error',
              name: result.error.name,
              message: result.error.message,
              ...(result.error.stack !== undefined && { stack: result.error.stack }),
            })
          } else if (result.type === 'cancelled') {
            yield* emitEvent({
              type: 'cancelled',
              ...(result.reason !== undefined && { reason: result.reason }),
            })
          }
        } catch (error) {
          const err = error as Error
          yield* emitEvent({
            type: 'error',
            name: err.name,
            message: err.message,
            ...(err.stack !== undefined && { stack: err.stack }),
          })
        } finally {
        yield* eventChannel.close()
      }
    })

    // Create the session interface
    const session: ToolSession = {
      id: sessionId,
      toolName,

      *status(): Operation<ToolSessionStatus> {
        return status
      },

      events(afterLSN?: number): Stream<ToolSessionEvent, void> {
        // Return a stream that replays buffered events then subscribes to new ones
        return resource<Subscription<ToolSessionEvent, void>>(function* (provideStream) {
          // Subscribe to the channel for new events
          const channelSub = yield* eventChannel

          // Combine buffered events with live stream
          let bufferedIndex = afterLSN ?? 0

          yield* provideStream({
            *next() {
              // First drain buffered events
              if (bufferedIndex < eventBuffer.length) {
                const event = eventBuffer[bufferedIndex]!
                bufferedIndex++
                return { done: false, value: event }
              }

              // Then read from live channel
              return yield* channelSub.next()
            },
          })
        })
      },

      *respondToElicit(elicitId: string, response: RawElicitResult<unknown>): Operation<void> {
        const pending = pendingElicits.get(elicitId)
        if (pending) {
          pending.resolve(response)
          pendingElicits.delete(elicitId)
        }
        // Note: With the new architecture, responses flow through the request handler,
        // not through explicit respondTo calls. This is kept for API compatibility.
      },

      *respondToSample(sampleId: string, response: RawSampleResult): Operation<void> {
        const pending = pendingSamples.get(sampleId)
        if (pending) {
          pending.resolve(response)
          pendingSamples.delete(sampleId)
        }
        // Note: With the new architecture, responses flow through the request handler,
        // not through explicit respondTo calls. This is kept for API compatibility.
      },

      *cancel(reason?: string): Operation<void> {
        // Closing the resource will trigger worker shutdown
        yield* emitEvent({
          type: 'cancelled',
          ...(reason !== undefined && { reason }),
        })
        status = 'cancelled'
      },

      *emitWakeUp(): Operation<void> {
        // Worker sessions don't need wake-up events - they use message passing
        // between the host and worker thread, which has its own scheduling.
        // This is a no-op for worker sessions.
      },
    }

    try {
      yield* provide(session)
    } finally {
      yield* eventChannel.close()
    }
  })
}
