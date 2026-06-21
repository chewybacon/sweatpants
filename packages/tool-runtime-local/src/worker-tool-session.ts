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
 * Uses @sweatpants/core's createWorkerPrincipal which handles:
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
  type Channel,
  resource,
  createChannel,
  spawn,
} from 'effection'
import {
  createWorkerPrincipal,
  type WorkerRequest,
  type WorkerResponse,
  type WorkerResult,
} from '@sweatpants/core/transport/worker'
import type {
  ToolSession,
  ToolSessionStatus,
  ToolSessionEvent,
  RawSampleResult,
} from '@sweatpants/framework/chat/mcp-tools'
import type { RawElicitResult, ExtendedMessage } from '@sweatpants/framework/chat/mcp-tools'
import type { McpWorkerInitData } from './worker-types.ts'
import { WorkerSessionStateContext, type WorkerSessionState } from './worker-session-context.ts'
import { WorkerSessionApi } from './worker-session-api.ts'

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
  parentMessages?: ExtendedMessage[]
  /** Extra execArgv for the worker thread (e.g., ['--import', 'tsx'] for TypeScript support) */
  execArgv?: string[]
}

/**
 * Create a ToolSession backed by a web worker.
 *
 * This resource:
 * 1. Spawns a worker with the tool to execute
 * 2. Handles requests from the worker via WorkerSessionApi operations
 * 3. Exposes the ToolSession interface for the host to interact
 *
 * @param options - Session configuration
 * @returns A ToolSession resource
 */
export function createWorkerToolSession(
  options: WorkerToolSessionOptions
): Operation<ToolSession> {
  return resource<ToolSession>(function* (provide) {
    const { sessionId, toolName, params, workerUrl, systemPrompt, parentMessages, execArgv } = options

    // State
    let status: ToolSessionStatus = 'initializing'
    let lsn = 0
    const eventBuffer: ToolSessionEvent[] = []

    // Channel for streaming events to subscribers
    const eventChannel = createChannel<ToolSessionEvent, void>()

    const pendingSamples = new Map<string, Channel<RawSampleResult, void>>()
    const pendingElicits = new Map<string, Channel<RawElicitResult<unknown>, void>>()

    function nextLsn(): number {
      lsn += 1
      return lsn
    }

    // Helper to emit events
    // Using a more permissive input type to avoid TypeScript's excess property checking issues
    // with discriminated unions - the 'type' field discriminates at runtime
    function* emitEvent(
      event: { type: ToolSessionEvent['type'] } & Record<string, unknown>
    ): Operation<void> {
      const fullEvent: ToolSessionEvent = {
        ...event,
        lsn: nextLsn(),
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

    const sessionState: WorkerSessionState = {
      pendingElicitChannels: pendingElicits,
      pendingSampleChannels: pendingSamples,
      emitEvent,
      nextLsn,
      setStatus: (nextStatus: ToolSessionStatus) => {
        status = nextStatus
      },
    }

    yield* WorkerSessionStateContext.set(sessionState)

    // Build init data for the worker
    const initData: McpWorkerInitData = {
      toolName,
      params,
      sessionId,
      ...(systemPrompt !== undefined && { systemPrompt }),
      ...(parentMessages !== undefined && { parentMessages }),
    }

    // Create the worker using core's createWorkerPrincipal
    // Note: We use WorkerSessionStateContext.with() to ensure the context is available
    // in the spawned request handler scope inside createWorkerPrincipal
    const { result: workerResult } = yield* createWorkerPrincipal<unknown>({
      workerUrl,
      initData: initData as unknown as Parameters<typeof createWorkerPrincipal>[0]['initData'],
      ...(execArgv && execArgv.length > 0 ? { execArgv } : {}),
      requestHandler: function* (request: WorkerRequest): Operation<WorkerResponse> {
        // Re-establish context for this handler scope
        return yield* WorkerSessionStateContext.with(sessionState, function* () {
          if (request.type === 'sample') {
            return yield* WorkerSessionApi.operations.handleSampleRequest(request)
          }

          if (request.type === 'elicit') {
            return yield* WorkerSessionApi.operations.handleElicitRequest(request)
          }

          throw new Error(`Unknown request type: ${(request as WorkerRequest).type}`)
        })
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
          // Snapshot the buffer length at subscription time
          // Events added after this point will come from the channel
          const bufferSnapshotLength = eventBuffer.length

          // Subscribe to the channel for new events AFTER snapshotting
          const channelSub = yield* eventChannel

          // Combine buffered events with live stream
          let bufferedIndex = afterLSN ?? 0

          yield* provideStream({
            *next() {
              // First drain buffered events up to the snapshot point
              if (bufferedIndex < bufferSnapshotLength) {
                const event = eventBuffer[bufferedIndex]!
                bufferedIndex++
                return { done: false, value: event }
              }

              // Then read from live channel (no deduplication needed since we
              // snapshotted the buffer before subscribing to the channel)
              return yield* channelSub.next()
            },
          })
        })
      },

      *respondToElicit(elicitId: string, response: RawElicitResult<unknown>): Operation<void> {
        yield* WorkerSessionStateContext.with(sessionState, function* () {
          yield* WorkerSessionApi.operations.respondToElicit(elicitId, response)
        })
      },

      *respondToSample(sampleId: string, response: RawSampleResult): Operation<void> {
        yield* WorkerSessionStateContext.with(sessionState, function* () {
          yield* WorkerSessionApi.operations.respondToSample(sampleId, response)
        })
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
      for (const channel of pendingElicits.values()) {
        yield* channel.close()
      }
      for (const channel of pendingSamples.values()) {
        yield* channel.close()
      }
      pendingElicits.clear()
      pendingSamples.clear()
      yield* eventChannel.close()
    }
  })
}
