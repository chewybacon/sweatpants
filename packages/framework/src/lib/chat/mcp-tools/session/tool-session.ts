/**
 * In-Memory Tool Session Implementation
 *
 * Wraps the bridge-runtime to provide a durable session interface.
 * Keeps the Effection generator alive and manages event buffering
 * for SSE resumability.
 *
 * IMPORTANT: This implementation uses native Promises (not Effection signals)
 * for cross-scope communication. When `respondToSample` or `respondToElicit`
 * is called from an HTTP handler scope, it resolves a Promise that the tool
 * execution is waiting on via `call()`. This pattern works across Effection
 * scopes because Promise resolution is handled by the JS event loop, not
 * Effection's scheduler.
 *
 * @packageDocumentation
 */
import {
  type Operation,
  type Stream,
  type Subscription,
  createChannel,
  spawn,
  resource,
  each,
  call,
} from 'effection'
import type {
  ToolSession,
  ToolSessionStatus,
  ToolSessionEvent,
  ToolSessionOptions,
  ToolSessionSamplingProvider,
  ElicitRequestEvent,
  SampleRequestEvent,
  ProgressEvent,
  LogEvent,
  ResultEvent,
  ErrorEvent,
  CancelledEvent,
} from './types'
import type {
  ElicitResult,
  SampleResult,
  ElicitsMap,
} from '../mcp-tool-types'
import type { FinalizedMcpToolWithElicits } from '../mcp-tool-builder'
import { createBridgeHost } from '../bridge-runtime'

// =============================================================================
// INTERNAL TYPES
// =============================================================================

/**
 * Pending sample request - uses Promise for cross-scope resolution.
 */
interface PendingSample {
  id: string
  resolve: (result: SampleResult) => void
}

/**
 * Pending elicit request - uses Promise for cross-scope resolution.
 */
interface PendingElicit {
  id: string
  resolve: (result: ElicitResult<unknown>) => void
}

/**
 * Internal state for the session.
 */
interface SessionState<TResult> {
  status: ToolSessionStatus
  lsn: number
  eventBuffer: ToolSessionEvent<TResult>[]
  pendingElicit: PendingElicit | null
  pendingSample: PendingSample | null
  result: TResult | null
  error: Error | null
  cancelled: boolean
  cancelReason: string | undefined
}

// =============================================================================
// TOOL SESSION IMPLEMENTATION
// =============================================================================

/**
 * Create an in-memory tool session.
 *
 * This is a resource that keeps the tool's generator alive and manages
 * event buffering for SSE resumability.
 *
 * @param tool - The tool to execute
 * @param params - Tool parameters
 * @param _samplingProvider - Not used (kept for API compatibility)
 * @param options - Session options
 */
export function createToolSession<
  TName extends string,
  TParams,
  THandoff,
  TClient,
  TResult,
  TElicits extends ElicitsMap,
>(
  tool: FinalizedMcpToolWithElicits<TName, TParams, THandoff, TClient, TResult, TElicits>,
  params: TParams,
  _samplingProvider: ToolSessionSamplingProvider, // Not used - sampling via responseSignal
  options: ToolSessionOptions = {}
): Operation<ToolSession<TResult>> {
  return resource<ToolSession<TResult>>(function* (provide) {
    const sessionId = options.sessionId ?? generateSessionId()

    // Session state
    const state: SessionState<TResult> = {
      status: 'initializing',
      lsn: 0,
      eventBuffer: [],
      pendingElicit: null,
      pendingSample: null,
      result: null,
      error: null,
      cancelled: false,
      cancelReason: undefined,
    }

    // Channel for event subscribers
    const eventChannel = createChannel<ToolSessionEvent<TResult>, void>()

    // Helper to emit an event
    function* emitEvent(
      event: Omit<ToolSessionEvent<TResult>, 'lsn' | 'timestamp'>
    ): Operation<void> {
      const fullEvent = {
        ...event,
        lsn: ++state.lsn,
        timestamp: Date.now(),
      } as ToolSessionEvent<TResult>

      // Buffer for resumability
      state.eventBuffer.push(fullEvent)

      // Send to subscribers
      yield* eventChannel.send(fullEvent)
    }

    // Create the bridge host config
    const hostConfig = {
      tool,
      params,
      callId: sessionId,
      ...(options.signal !== undefined && { signal: options.signal }),
      ...(options.parentMessages !== undefined && { parentMessages: options.parentMessages }),
      ...(options.systemPrompt !== undefined && { systemPrompt: options.systemPrompt }),
    }

    const host = createBridgeHost(hostConfig)

    // Track whether tool execution has started
    let toolExecutionStarted = false

    /**
     * Start tool execution. This should be called from within the SSE
     * stream's scope.run() so that Promise resolutions (from respondToSample)
     * are processed by the same Effection scheduler.
     */
    function* startToolExecution(): Operation<void> {
      if (toolExecutionStarted) return
      toolExecutionStarted = true
      
      yield* spawn(function* () {
        try {
          state.status = 'running'

          // Process events from the bridge
          yield* spawn(function* () {
            for (const event of yield* each(host.events)) {
              switch (event.type) {
                case 'elicit': {
                  const elicitId = `${sessionId}:elicit:${state.lsn}`

                  // Create a Promise for the response
                  let resolveElicit: (result: ElicitResult<unknown>) => void
                  const elicitPromise = new Promise<ElicitResult<unknown>>((resolve) => {
                    resolveElicit = resolve
                  })

                  state.status = 'awaiting_elicit'
                  state.pendingElicit = { id: elicitId, resolve: resolveElicit! }

                  // Emit the elicit request event
                  yield* emitEvent({
                    type: 'elicit_request',
                    elicitId,
                    key: event.request.key,
                    message: event.request.message,
                    schema: event.request.schema.json,
                  } as Omit<ElicitRequestEvent, 'lsn' | 'timestamp'>)

                  // Wait for response via Promise
                  const response = yield* call(() => elicitPromise)

                  state.pendingElicit = null
                  state.status = 'running'

                  // Forward response to the bridge
                  event.responseSignal.send({ id: event.request.id, result: response })
                  break
                }

              case 'sample': {
                const sampleId = `${sessionId}:sample:${state.lsn}`

                // Create a Promise for the response
                let resolveSample: (result: SampleResult) => void
                const samplePromise = new Promise<SampleResult>((resolve) => {
                  resolveSample = resolve
                })

                state.status = 'awaiting_sample'
                state.pendingSample = { id: sampleId, resolve: resolveSample! }

                // Emit the sample request event to SSE stream
                yield* emitEvent({
                  type: 'sample_request',
                  sampleId,
                  messages: event.messages,
                  systemPrompt: event.options?.systemPrompt,
                  maxTokens: event.options?.maxTokens,
                } as Omit<SampleRequestEvent, 'lsn' | 'timestamp'>)

                // Wait for response via Promise
                const response = yield* call(() => samplePromise)

                state.pendingSample = null
                state.status = 'running'

                // Forward response to the bridge's signal
                event.responseSignal.send({ result: response })
                break
              }

                case 'log':
                  yield* emitEvent({
                    type: 'log',
                    level: event.level,
                    message: event.message,
                  } as Omit<LogEvent, 'lsn' | 'timestamp'>)
                  break

                case 'notify':
                  yield* emitEvent({
                    type: 'progress',
                    message: event.message,
                    progress: event.progress,
                  } as Omit<ProgressEvent, 'lsn' | 'timestamp'>)
                  break
              }
              yield* each.next()
            }
          })

          // Run the tool
          const result = yield* host.run()

          state.status = 'completed'
          state.result = result

          yield* emitEvent({
            type: 'result',
            result,
          } as Omit<ResultEvent<TResult>, 'lsn' | 'timestamp'>)
        } catch (error) {
          state.status = 'failed'
          state.error = error as Error

          yield* emitEvent({
            type: 'error',
            name: (error as Error).name,
            message: (error as Error).message,
            stack: (error as Error).stack,
          } as Omit<ErrorEvent, 'lsn' | 'timestamp'>)
        } finally {
          yield* eventChannel.close()
        }
      })
    }

    // Create the session interface
    const session: ToolSession<TResult> = {
      id: sessionId,
      toolName: tool.name,

      *status(): Operation<ToolSessionStatus> {
        return state.status
      },

      events(afterLSN?: number): Stream<ToolSessionEvent<TResult>, void> {
        return resource<Subscription<ToolSessionEvent<TResult>, void>>(function* (provide) {
          const startLSN = afterLSN ?? 0

          // Start tool execution when events are first subscribed to.
          // This ensures the tool runs in the same Effection scope as the
          // event consumer, allowing Promise resolutions to be processed.
          yield* startToolExecution()

          // Replay buffer
          const bufferedEvents = state.eventBuffer.filter(e => e.lsn > startLSN)
          let bufferedIndex = 0

          // Subscribe to live channel
          const liveSubscription = yield* eventChannel

          yield* provide({
            *next(): Operation<IteratorResult<ToolSessionEvent<TResult>, void>> {
              // First drain buffered events
              if (bufferedIndex < bufferedEvents.length) {
                const event = bufferedEvents[bufferedIndex]
                bufferedIndex++
                return { done: false, value: event as ToolSessionEvent<TResult> }
              }

              // Then forward from live subscription
              return yield* liveSubscription.next()
            },
          })
        })
      },

      *respondToElicit(elicitId: string, response: ElicitResult<unknown>): Operation<void> {
        const pending = state.pendingElicit
        if (!pending) {
          return
        }
        if (pending.id !== elicitId) {
          throw new Error(
            `Elicitation ID mismatch: expected ${pending.id}, got ${elicitId}`
          )
        }

        // Resolve the Promise using setImmediate to ensure it happens
        // outside the current Effection tick.
        setImmediate(() => {
          pending.resolve(response)
        })
        // Note: state is cleared by the event handler after the promise resolves
      },

      *respondToSample(sampleId: string, response: SampleResult): Operation<void> {
        const pending = state.pendingSample
        if (!pending) {
          return
        }
        if (pending.id !== sampleId) {
          throw new Error(
            `Sample ID mismatch: expected ${pending.id}, got ${sampleId}`
          )
        }

        // Resolve the Promise using setImmediate to ensure it happens
        // outside the current Effection tick. This allows the Promise
        // resolution to be picked up by the event loop and processed
        // by any waiting tasks.
        setImmediate(() => {
          pending.resolve(response)
        })
        // Note: state is cleared by the event handler after the promise resolves
      },

      *emitWakeUp(): Operation<void> {
        // No longer needed - Promise resolution handles wake-up automatically
      },

      *cancel(reason?: string): Operation<void> {
        if (state.status === 'completed' || state.status === 'failed' || state.status === 'cancelled') {
          return
        }

        state.status = 'cancelled'
        state.cancelled = true
        state.cancelReason = reason

        yield* emitEvent({
          type: 'cancelled',
          reason,
        } as Omit<CancelledEvent, 'lsn' | 'timestamp'>)

        yield* eventChannel.close()
      },
    }

    yield* provide(session)
  })
}

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Generate a unique session ID.
 */
function generateSessionId(): string {
  return `session_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`
}
