/**
 * Core-Based Tool Session (Host/Operative Side)
 *
 * This module provides the host-side adapter that receives requests from a worker
 * running tools via the core transport, and emits them as session events.
 *
 * ## Architecture
 *
 * ```
 * Worker (Principal)                     Host (Operative)
 * ─────────────────────────────────────────────────────────────────────
 * runWorkerCore() ───────────────────► createCoreToolSession()
 *                                       │
 * ctx.sample() ──────────────────────► receives TransportRequest
 *                                       │ emits SampleRequestEvent
 *                                       │ waits for respondToSample()
 *             ◄────────────────────────│ sends ResponseMessage
 *
 * ctx.elicit() ─────────────────────► receives TransportRequest
 *                                       │ emits ElicitRequestEvent
 *                                       │ waits for respondToElicit()
 *             ◄────────────────────────│ sends ResponseMessage
 * ```
 *
 * ## Usage
 *
 * This is an alternative to `createToolSession()` for when the tool runs
 * in a worker using `runWorkerCore()`. It bridges the transport-based
 * communication to the existing session event model.
 *
 * @packageDocumentation
 */

import {
  type Operation,
  type Stream,
  type Subscription,
  resource,
  createQueue,
  sleep,
} from 'effection'
import type {
  ToolSession,
  ToolSessionStatus,
  ToolSessionEvent,
  ElicitRequestEvent,
  SampleRequestEvent,
  ProgressEvent,
  LogEvent,
  ResultEvent,
  ErrorEvent,
  CancelledEvent,
} from './types.ts'
import type { RawElicitResult, RawSampleResult } from '../mcp-tool-types.ts'
import type { HostTransport, WorkerToHostMessage } from './worker-types.ts'

// =============================================================================
// CORE TOOL SESSION OPTIONS
// =============================================================================

/**
 * Options for creating a core-based tool session.
 */
export interface CoreToolSessionOptions {
  /** Session ID (generated if not provided) */
  sessionId?: string
  /** Tool name for logging/correlation */
  toolName: string
  /** Abort signal for cancellation */
  signal?: AbortSignal
}

// =============================================================================
// INTERNAL STATE
// =============================================================================

interface PendingRequest {
  id: string
  kind: 'sample' | 'elicit'
}

interface SessionState<TResult> {
  status: ToolSessionStatus
  lsn: number
  pendingRequest: PendingRequest | null
  result: TResult | null
  error: Error | null
  toolCompleted: boolean
}

// =============================================================================
// CORE TOOL SESSION
// =============================================================================

/**
 * Create a core-based tool session from a host transport.
 *
 * This session listens for requests from a worker running `runWorkerCore()`
 * and emits them as session events. The session consumer responds to events
 * using `respondToSample()` or `respondToElicit()`, which sends the response
 * back to the worker via the transport.
 *
 * @param hostTransport - The host-side transport (receives from worker, sends to worker)
 * @param options - Session options
 */
export function createCoreToolSession<TResult = unknown>(
  hostTransport: HostTransport,
  options: CoreToolSessionOptions
): Operation<ToolSession<TResult>> {
  return resource<ToolSession<TResult>>(function* (provide) {
    const sessionId = options.sessionId ?? generateSessionId()
    const { toolName } = options

    // Session state
    const state: SessionState<TResult> = {
      status: 'initializing',
      lsn: 0,
      pendingRequest: null,
      result: null,
      error: null,
      toolCompleted: false,
    }

    // Event queue - producer (transport listener) pushes, consumer pulls
    const eventQueue = createQueue<ToolSessionEvent<TResult>, void>()

    // Helper to create event with LSN and timestamp
    function createEvent(
      event: Omit<ToolSessionEvent<TResult>, 'lsn' | 'timestamp'>
    ): ToolSessionEvent<TResult> {
      return {
        ...event,
        lsn: ++state.lsn,
        timestamp: Date.now(),
      } as ToolSessionEvent<TResult>
    }

    // Start listening for requests from worker
    state.status = 'running'

    // Subscribe to worker messages and handle them
    hostTransport.subscribe((msg: WorkerToHostMessage) => {
      switch (msg.type) {
        case 'ready':
          // Worker is ready - no action needed
          break

        case 'sample_request':
          state.status = 'awaiting_sample'
          state.pendingRequest = { id: msg.sampleId, kind: 'sample' }
          eventQueue.add(
            createEvent({
              type: 'sample_request',
              sampleId: msg.sampleId,
              messages: msg.messages,
              systemPrompt: msg.systemPrompt,
              maxTokens: msg.maxTokens,
              tools: msg.tools as SampleRequestEvent['tools'],
              toolChoice: msg.toolChoice as SampleRequestEvent['toolChoice'],
              schema: msg.schema,
            } as Omit<SampleRequestEvent, 'lsn' | 'timestamp'>)
          )
          break

        case 'elicit_request':
          state.status = 'awaiting_elicit'
          state.pendingRequest = { id: msg.elicitId, kind: 'elicit' }
          eventQueue.add(
            createEvent({
              type: 'elicit_request',
              elicitId: msg.elicitId,
              key: msg.key,
              message: msg.message,
              schema: msg.schema,
            } as Omit<ElicitRequestEvent, 'lsn' | 'timestamp'>)
          )
          break

        case 'log':
          eventQueue.add(
            createEvent({
              type: 'log',
              level: msg.level,
              message: msg.message,
            } as Omit<LogEvent, 'lsn' | 'timestamp'>)
          )
          break

        case 'progress':
          eventQueue.add(
            createEvent({
              type: 'progress',
              message: msg.message,
              progress: msg.progress,
            } as Omit<ProgressEvent, 'lsn' | 'timestamp'>)
          )
          break

        case 'result':
          state.status = 'completed'
          state.result = msg.result as TResult
          state.toolCompleted = true
          eventQueue.add(
            createEvent({
              type: 'result',
              result: msg.result as TResult,
            } as Omit<ResultEvent<TResult>, 'lsn' | 'timestamp'>)
          )
          eventQueue.close()
          break

        case 'error':
          state.status = 'failed'
          state.error = new Error(msg.message)
          state.toolCompleted = true
          eventQueue.add(
            createEvent({
              type: 'error',
              name: msg.name,
              message: msg.message,
              stack: msg.stack,
            } as Omit<ErrorEvent, 'lsn' | 'timestamp'>)
          )
          eventQueue.close()
          break

        case 'cancelled':
          state.status = 'cancelled'
          state.toolCompleted = true
          eventQueue.add(
            createEvent({
              type: 'cancelled',
              reason: msg.reason,
            } as Omit<CancelledEvent, 'lsn' | 'timestamp'>)
          )
          eventQueue.close()
          break
      }
    })

    // Give spawned tasks a chance to start
    yield* sleep(0)

    // Create session interface
    const session: ToolSession<TResult> = {
      id: sessionId,
      toolName,

      *status(): Operation<ToolSessionStatus> {
        return state.status
      },

      events(_afterLSN?: number): Stream<ToolSessionEvent<TResult>, void> {
        return resource<Subscription<ToolSessionEvent<TResult>, void>>(function* (provide) {
          yield* provide({
            *next(): Operation<IteratorResult<ToolSessionEvent<TResult>, void>> {
              return yield* eventQueue.next()
            },
          })
        })
      },

      *respondToElicit(elicitId: string, response: RawElicitResult<unknown>): Operation<void> {
        const pending = state.pendingRequest
        if (!pending || pending.kind !== 'elicit') {
          return
        }
        if (pending.id !== elicitId) {
          throw new Error(`Elicit ID mismatch: expected ${pending.id}, got ${elicitId}`)
        }

        state.pendingRequest = null
        state.status = 'running'

        // Send ElicitResponseMessage back to worker
        hostTransport.send({
          type: 'elicit_response',
          elicitId,
          response,
        })
        yield* sleep(0)
      },

      *respondToSample(sampleId: string, response: RawSampleResult): Operation<void> {
        const pending = state.pendingRequest
        if (!pending || pending.kind !== 'sample') {
          return
        }
        if (pending.id !== sampleId) {
          throw new Error(`Sample ID mismatch: expected ${pending.id}, got ${sampleId}`)
        }

        state.pendingRequest = null
        state.status = 'running'

        // Send SampleResponseMessage back to worker
        hostTransport.send({
          type: 'sample_response',
          sampleId,
          response,
        })
        yield* sleep(0)
      },

      *emitWakeUp(): Operation<void> {
        // No longer needed
      },

      *cancel(reason?: string): Operation<void> {
        if (
          state.status === 'completed' ||
          state.status === 'failed' ||
          state.status === 'cancelled'
        ) {
          return
        }

        state.status = 'cancelled'
        state.toolCompleted = true

        // Send cancel to worker
        if (reason !== undefined) {
          hostTransport.send({ type: 'cancel', reason })
        } else {
          hostTransport.send({ type: 'cancel' })
        }

        eventQueue.add(
          createEvent({
            type: 'cancelled',
            reason,
          } as Omit<CancelledEvent, 'lsn' | 'timestamp'>)
        )
        eventQueue.close()
      },
    }

    yield* provide(session)
  })
}

// =============================================================================
// HELPERS
// =============================================================================

function generateSessionId(): string {
  return `session_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`
}
