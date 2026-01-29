/**
 * Signal-Based Correlated Transport
 *
 * Implements core's `CorrelatedTransport` interface using Effection signals
 * for request/response correlation. This approach handles stateless operatives
 * where responses can take arbitrarily long (minutes, hours, days).
 *
 * ## Why Signals Instead of Core's createCorrelation?
 *
 * See `docs/adr-signal-based-transport.md` for the full architecture decision.
 *
 * TL;DR: Core's `createCorrelation` assumes a live, bidirectional Stream connection.
 * Our worker transport uses callback-based `subscribe()` and responses can take
 * arbitrary time. The signal pattern handles this correctly:
 *
 * 1. Create a signal for each request
 * 2. Store it in a Map keyed by request ID
 * 3. When response arrives, look up signal and send() to resume
 *
 * ## Usage
 *
 * ```typescript
 * const transport = yield* createSignalCorrelatedTransport(workerTransport)
 * yield* TransportContext.set(transport)
 *
 * // Now tools can use transport.request() backed by signals
 * ```
 *
 * @packageDocumentation
 */

import {
  createSignal,
  resource,
  type Operation,
  type Signal,
  type Stream,
  type Subscription,
} from 'effection'
import type {
  CorrelatedTransport,
  ElicitResponse,
  NotifyResponse,
  TransportRequest,
} from '@sweatpants/core'
import type {
  WorkerTransport,
  HostToWorkerMessage,
} from './worker-types.ts'
import type { Message, LogLevel, RawElicitResult } from '../mcp-tool-types.ts'

// =============================================================================
// SIGNAL CORRELATED TRANSPORT
// =============================================================================

/**
 * Create a CorrelatedTransport backed by Effection signals.
 *
 * This provides the standard `CorrelatedTransport` interface that tools expect,
 * but uses signals internally for request/response correlation. This handles
 * the stateless operative scenario where responses can take arbitrarily long.
 *
 * @param transport - The worker-side transport (sends to host, receives from host)
 */
export function* createSignalCorrelatedTransport(
  transport: WorkerTransport
): Operation<CorrelatedTransport> {
  // Track pending requests by ID
  // Key is the request ID from TransportRequest.id
  const pendingRequests = new Map<string, Signal<ElicitResponse | NotifyResponse, void>>()

  // Subscribe to incoming messages and route to signals
  const unsubscribe = transport.subscribe((msg: HostToWorkerMessage) => {
    if (msg.type === 'sample_response') {
      const signal = pendingRequests.get(msg.sampleId)
      if (signal) {
        // Convert to core's ElicitResponse format
        const response: ElicitResponse = {
          status: 'accepted',
          content: msg.response,
        }
        signal.send(response)
        pendingRequests.delete(msg.sampleId)
      }
    } else if (msg.type === 'elicit_response') {
      const signal = pendingRequests.get(msg.elicitId)
      if (signal) {
        // Convert RawElicitResult to core's ElicitResponse
        const response = mapRawElicitToCore(msg.response)
        signal.send(response)
        pendingRequests.delete(msg.elicitId)
      }
    }
    // Note: We don't handle progress messages here since the current
    // worker protocol treats them as fire-and-forget (notify, not elicit)
  })

  // Create the correlated transport
  const correlatedTransport: CorrelatedTransport = {
    request<TProgress, TResponse extends ElicitResponse | NotifyResponse>(
      message: TransportRequest
    ): Stream<TProgress, TResponse> {
      return resource<Subscription<TProgress, TResponse>>(function* (provide) {
        // Create signal for this request using the provided message.id
        const signal = createSignal<TResponse, void>()
        pendingRequests.set(message.id, signal as Signal<ElicitResponse | NotifyResponse, void>)

        // Map and send via worker transport
        sendRequest(transport, message)

        // Get subscription from signal
        const signalSub: Subscription<TResponse, void> = yield* signal

        // Wrap to convert signal's iteration pattern to what CorrelatedTransport expects
        // Signal yields values via send(), we treat the first value as the response
        const wrappedSub: Subscription<TProgress, TResponse> = {
          *next(): Operation<IteratorResult<TProgress, TResponse>> {
            const result = yield* signalSub.next()
            if (result.done) {
              // Signal closed without response - shouldn't happen in normal flow
              throw new Error(`Request ${message.id} signal closed without response`)
            }
            // Got value from signal - this is our response
            // Return as done since we're single-response (no progress streaming for now)
            return { done: true, value: result.value }
          },
        }

        try {
          yield* provide(wrappedSub)
        } finally {
          // Cleanup on teardown
          pendingRequests.delete(message.id)
        }
      })
    },
  }

  // Wrap in resource to handle cleanup
  return yield* resource<CorrelatedTransport>(function* (provide) {
    try {
      yield* provide(correlatedTransport)
    } finally {
      unsubscribe()
    }
  })
}

// =============================================================================
// MESSAGE MAPPING
// =============================================================================

/**
 * Send a TransportRequest via the worker transport.
 * Maps from core's message format to worker message format.
 */
function sendRequest(
  transport: WorkerTransport,
  message: TransportRequest
): void {
  if (message.kind === 'elicit' && message.type === 'sample') {
    // Sample request
    const payload = message.payload as {
      messages: Message[]
      systemPrompt?: string
      maxTokens?: number
      tools?: unknown[]
      toolChoice?: string
      schema?: Record<string, unknown>
    }

    transport.send({
      type: 'sample_request',
      sampleId: message.id,
      messages: payload.messages,
      ...(payload.systemPrompt !== undefined && { systemPrompt: payload.systemPrompt }),
      ...(payload.maxTokens !== undefined && { maxTokens: payload.maxTokens }),
      ...(payload.tools !== undefined && { tools: payload.tools }),
      ...(payload.toolChoice !== undefined && { toolChoice: payload.toolChoice }),
      ...(payload.schema !== undefined && { schema: payload.schema }),
      lsn: 0, // LSN managed by caller
    })
  } else if (message.kind === 'elicit') {
    // Elicit request (non-sample)
    const payload = message.payload as {
      key: string
      message: string
      schema: Record<string, unknown>
      context?: unknown
    }

    transport.send({
      type: 'elicit_request',
      elicitId: message.id,
      key: payload.key,
      message: payload.message,
      schema: payload.schema,
      lsn: 0,
    })
  } else if (message.kind === 'notify') {
    // Notify - log or progress (fire-and-forget)
    const payload = message.payload as {
      level?: LogLevel
      message: string
      progress?: number
    }

    if (payload.level) {
      // Log message
      transport.send({
        type: 'log',
        level: payload.level,
        message: payload.message,
        lsn: 0,
      })
    } else {
      // Progress message
      transport.send({
        type: 'progress',
        message: payload.message,
        ...(payload.progress !== undefined && { progress: payload.progress }),
        lsn: 0,
      })
    }
  }
}

/**
 * Map RawElicitResult to core's ElicitResponse format.
 */
function mapRawElicitToCore(raw: RawElicitResult<unknown>): ElicitResponse {
  if (raw.action === 'accept') {
    return {
      status: 'accepted',
      content: raw.content,
    }
  } else if (raw.action === 'decline') {
    return { status: 'declined' }
  } else {
    return { status: 'cancelled' }
  }
}

// =============================================================================
// EXPORTS
// =============================================================================

export type { CorrelatedTransport }
