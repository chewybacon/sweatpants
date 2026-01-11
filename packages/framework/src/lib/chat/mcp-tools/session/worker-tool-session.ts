/**
 * Worker-based Tool Session
 *
 * Adapts a worker transport to the ToolSession interface.
 * This allows the existing MCP handler infrastructure to work
 * with tools running in isolated worker threads.
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
 *   │ postMessage/onmessage
 *   ▼
 * Worker (running tool generator)
 * ```
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
import type {
  ToolSession,
  ToolSessionStatus,
  ToolSessionEvent,
  SampleResult,
} from './types.ts'
import type {
  HostTransport,
  WorkerToHostMessage,
  StartMessage,
} from './worker-types.ts'
import type { ElicitResult } from '../mcp-tool-types.ts'

// =============================================================================
// WORKER TOOL SESSION
// =============================================================================

/**
 * Options for creating a worker tool session.
 */
import type { Message } from '../mcp-tool-types.ts'

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
  /** Optional system prompt */
  systemPrompt?: string
  /** Optional parent messages */
  parentMessages?: Message[]
}

/**
 * Create a ToolSession backed by a worker transport.
 *
 * This resource:
 * 1. Sends the 'start' message to the worker
 * 2. Subscribes to worker messages and converts them to ToolSessionEvents
 * 3. Implements respondToSample/respondToElicit by sending messages to worker
 *
 * @param transport - The host-side transport to the worker
 * @param options - Session configuration
 * @returns A ToolSession resource
 */
export function createWorkerToolSession(
  transport: HostTransport,
  options: WorkerToolSessionOptions
): Operation<ToolSession> {
  return resource<ToolSession>(function* (provide) {
    const { sessionId, toolName, params, systemPrompt, parentMessages } = options

    // State
    let status: ToolSessionStatus = 'initializing'
    let lsn = 0
    const eventBuffer: ToolSessionEvent[] = []

    // Channel for streaming events to subscribers
    const eventChannel = createChannel<ToolSessionEvent, void>()

    // Map of pending sample/elicit requests
    // We need to track these so respondToSample/respondToElicit know what to do
    const pendingSamples = new Map<string, true>()
    const pendingElicits = new Map<string, true>()

    // Subscribe to worker messages
    const unsubscribe = transport.subscribe((msg: WorkerToHostMessage) => {
      // Convert worker message to ToolSessionEvent
      const event = workerMessageToEvent(msg)
      if (event) {
        // Update LSN if the message has one
        if ('lsn' in msg && typeof msg.lsn === 'number') {
          lsn = msg.lsn
        }
        event.lsn = lsn
        event.timestamp = Date.now()

        // Buffer the event
        eventBuffer.push(event)

        // Update status based on event type
        switch (event.type) {
          case 'sample_request':
            status = 'awaiting_sample'
            pendingSamples.set(event.sampleId, true)
            break
          case 'elicit_request':
            status = 'awaiting_elicit'
            pendingElicits.set(event.elicitId, true)
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
          default:
            if (status === 'initializing') {
              status = 'running'
            }
        }

        // Send to channel (for subscribers)
        // Note: This is fire-and-forget, channel buffers
        spawn(function* () {
          yield* eventChannel.send(event)
        })
      }
    })

    // Start the tool
    status = 'running'
    const startMessage: StartMessage = {
      type: 'start',
      toolName,
      params,
      sessionId,
      ...(systemPrompt !== undefined && { systemPrompt }),
      ...(parentMessages !== undefined && { parentMessages }),
    }
    transport.send(startMessage)

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
          // First, yield any buffered events after afterLSN
          const startIndex = afterLSN ?? 0
          for (let i = startIndex; i < eventBuffer.length; i++) {
            // We need to provide a subscription interface
            // For simplicity, just subscribe to the channel and prepend buffered events
          }

          // Subscribe to the channel for new events
          const channelSub = yield* eventChannel

          // Combine buffered events with live stream
          let bufferedIndex = startIndex

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

      *respondToElicit(elicitId: string, response: ElicitResult<unknown>): Operation<void> {
        if (!pendingElicits.has(elicitId)) {
          throw new Error(`No pending elicit request with ID: ${elicitId}`)
        }

        transport.send({
          type: 'elicit_response',
          elicitId,
          response,
        })

        pendingElicits.delete(elicitId)
        status = 'running'
      },

      *respondToSample(sampleId: string, response: SampleResult): Operation<void> {
        if (!pendingSamples.has(sampleId)) {
          throw new Error(`No pending sample request with ID: ${sampleId}`)
        }

        transport.send({
          type: 'sample_response',
          sampleId,
          response,
        })

        pendingSamples.delete(sampleId)
        status = 'running'
      },

      *cancel(reason?: string): Operation<void> {
        transport.send({
          type: 'cancel',
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
      unsubscribe()
      yield* eventChannel.close()
    }
  })
}

// =============================================================================
// MESSAGE CONVERSION
// =============================================================================

/**
 * Convert a worker message to a ToolSessionEvent.
 * Returns null for messages that don't map to events (like 'ready').
 */
function workerMessageToEvent(msg: WorkerToHostMessage): ToolSessionEvent | null {
  switch (msg.type) {
    case 'progress':
      return {
        type: 'progress',
        message: msg.message,
        ...(msg.progress !== undefined && { progress: msg.progress }),
        lsn: msg.lsn,
        timestamp: Date.now(),
      }

    case 'log':
      return {
        type: 'log',
        level: msg.level,
        message: msg.message,
        lsn: msg.lsn,
        timestamp: Date.now(),
      }

    case 'sample_request':
      return {
        type: 'sample_request',
        sampleId: msg.sampleId,
        messages: msg.messages,
        ...(msg.systemPrompt !== undefined && { systemPrompt: msg.systemPrompt }),
        ...(msg.maxTokens !== undefined && { maxTokens: msg.maxTokens }),
        lsn: msg.lsn,
        timestamp: Date.now(),
      }

    case 'elicit_request':
      return {
        type: 'elicit_request',
        elicitId: msg.elicitId,
        key: msg.key,
        message: msg.message,
        schema: msg.schema,
        lsn: msg.lsn,
        timestamp: Date.now(),
      }

    case 'result':
      return {
        type: 'result',
        result: msg.result,
        lsn: msg.lsn,
        timestamp: Date.now(),
      }

    case 'error':
      return {
        type: 'error',
        name: msg.name,
        message: msg.message,
        ...(msg.stack !== undefined && { stack: msg.stack }),
        lsn: msg.lsn,
        timestamp: Date.now(),
      }

    case 'cancelled':
      return {
        type: 'cancelled',
        ...(msg.reason !== undefined && { reason: msg.reason }),
        lsn: msg.lsn,
        timestamp: Date.now(),
      }

    case 'ready':
      // 'ready' doesn't map to a ToolSessionEvent
      return null
  }
}
