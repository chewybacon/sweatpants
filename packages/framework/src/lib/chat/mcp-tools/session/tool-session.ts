/**
 * In-Memory Tool Session Implementation
 *
 * Wraps the bridge-runtime to provide a durable session interface.
 * Keeps the Effection generator alive and manages event buffering
 * for SSE resumability.
 *
 * @packageDocumentation
 */
import {
  type Operation,
  type Stream,
  type Signal,
  type Subscription,
  createSignal,
  createChannel,
  spawn,
  resource,
  each,
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
 * Internal state for the session.
 */
interface SessionState<TResult> {
  status: ToolSessionStatus
  lsn: number
  eventBuffer: ToolSessionEvent<TResult>[]
  pendingElicit: {
    id: string
    signal: Signal<ElicitResult<unknown>, void>
  } | null
  pendingSample: {
    id: string
    signal: Signal<SampleResult, void>
  } | null
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
 * @param samplingProvider - Provider for LLM sampling
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
  samplingProvider: ToolSessionSamplingProvider,
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

    // Create the bridge host config - spread optional properties conditionally
    // to satisfy exactOptionalPropertyTypes
    const hostConfig = {
      tool,
      params,
      samplingProvider,
      callId: sessionId,
      ...(options.signal !== undefined && { signal: options.signal }),
      ...(options.parentMessages !== undefined && { parentMessages: options.parentMessages }),
      ...(options.systemPrompt !== undefined && { systemPrompt: options.systemPrompt }),
    }

    const host = createBridgeHost(hostConfig)

    // Spawn the tool execution
    yield* spawn(function* () {
      try {
        state.status = 'running'

        // Process events from the bridge
        yield* spawn(function* () {
          for (const event of yield* each(host.events)) {
            switch (event.type) {
              case 'elicit': {
                // Create a signal for the response
                const responseSignal = createSignal<ElicitResult<unknown>, void>()
                const elicitId = `${sessionId}:elicit:${state.lsn}`

                state.status = 'awaiting_elicit'
                state.pendingElicit = { id: elicitId, signal: responseSignal }

                // Emit the elicit request event
                yield* emitEvent({
                  type: 'elicit_request',
                  elicitId,
                  key: event.request.key,
                  message: event.request.message,
                  schema: event.request.schema.json,
                } as Omit<ElicitRequestEvent, 'lsn' | 'timestamp'>)

                // Wait for response via the signal
                const subscription = yield* responseSignal
                const result = yield* subscription.next()

                // Handle the case where subscription completes without value
                if (result.done) {
                  throw new Error('Elicitation response signal closed without value')
                }

                const response = result.value

                state.pendingElicit = null
                state.status = 'running'

                // Forward response to the bridge
                event.responseSignal.send({ id: event.request.id, result: response })
                break
              }

              case 'sample': {
                // Create a signal for the response
                const responseSignal = createSignal<SampleResult, void>()
                const sampleId = `${sessionId}:sample:${state.lsn}`

                state.status = 'awaiting_sample'
                state.pendingSample = { id: sampleId, signal: responseSignal }

                // Emit the sample request event
                yield* emitEvent({
                  type: 'sample_request',
                  sampleId,
                  messages: event.messages,
                  systemPrompt: event.options?.systemPrompt,
                  maxTokens: event.options?.maxTokens,
                } as Omit<SampleRequestEvent, 'lsn' | 'timestamp'>)

                // Wait for response via the signal
                const subscription = yield* responseSignal
                const result = yield* subscription.next()

                // Handle the case where subscription completes without value
                if (result.done) {
                  throw new Error('Sample response signal closed without value')
                }

                // Note: response is available as result.value if needed
                // For now, the bridge runtime handles sampling internally

                state.pendingSample = null
                state.status = 'running'

                // The bridge runtime calls samplingProvider internally,
                // but we're intercepting here for external SSE clients.
                // For now, we'll let the bridge handle sampling directly.
                // This event is for observability only.
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

    // Create the session interface
    const session: ToolSession<TResult> = {
      id: sessionId,
      toolName: tool.name,

      *status(): Operation<ToolSessionStatus> {
        return state.status
      },

      events(afterLSN?: number): Stream<ToolSessionEvent<TResult>, void> {
        // Create a subscription that first replays buffered events,
        // then subscribes to new events from the channel
        return resource<Subscription<ToolSessionEvent<TResult>, void>>(function* (provide) {
          const startLSN = afterLSN ?? 0

          // Replay buffer of events that came before subscriber connected
          const bufferedEvents = state.eventBuffer.filter(e => e.lsn > startLSN)
          let bufferedIndex = 0

          // Subscribe to the live channel
          const liveSubscription = yield* eventChannel

          yield* provide({
            *next(): Operation<IteratorResult<ToolSessionEvent<TResult>, void>> {
              // First, drain buffered events
              if (bufferedIndex < bufferedEvents.length) {
                const event = bufferedEvents[bufferedIndex]
                bufferedIndex++
                // Type assertion safe: we already checked bounds
                return { done: false, value: event as ToolSessionEvent<TResult> }
              }

              // Then forward from live subscription
              return yield* liveSubscription.next()
            },
          })
        })
      },

      *respondToElicit(elicitId: string, response: ElicitResult<unknown>): Operation<void> {
        if (!state.pendingElicit) {
          throw new Error(`No pending elicitation`)
        }
        if (state.pendingElicit.id !== elicitId) {
          throw new Error(
            `Elicitation ID mismatch: expected ${state.pendingElicit.id}, got ${elicitId}`
          )
        }
        state.pendingElicit.signal.send(response)
      },

      *respondToSample(sampleId: string, response: SampleResult): Operation<void> {
        if (!state.pendingSample) {
          throw new Error(`No pending sample request`)
        }
        if (state.pendingSample.id !== sampleId) {
          throw new Error(
            `Sample ID mismatch: expected ${state.pendingSample.id}, got ${sampleId}`
          )
        }
        state.pendingSample.signal.send(response)
      },

      *cancel(reason?: string): Operation<void> {
        if (state.status === 'completed' || state.status === 'failed' || state.status === 'cancelled') {
          return // Already done
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
