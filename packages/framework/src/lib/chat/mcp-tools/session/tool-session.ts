/**
 * In-Memory Tool Session Implementation
 *
 * Wraps the bridge-runtime to provide a durable session interface.
 * The session survives across HTTP request boundaries, enabling multi-step
 * elicitation flows.
 *
 * Architecture:
 * - Session is created and tool execution starts immediately (spawned)
 * - `nextEvent()` blocks until the next event is available
 * - Events: elicit_request, sample_request, result, error, cancelled
 * - For elicits: consumer returns to client, client responds, new request calls `respondToElicit()` then `nextEvent()`
 * - For samples: consumer handles inline (calls LLM), then calls `respondToSample()` and `nextEvent()` again
 *
 * @packageDocumentation
 */
import {
  type Operation,
  type Signal,
  type Stream,
  type Subscription,
  spawn,
  resource,
  each,
  createQueue,
  sleep,
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
} from './types.ts'
import type {
  ElicitResult,
  SampleResult,
  ElicitsMap,
} from '../mcp-tool-types.ts'
import type { FinalizedMcpToolWithElicits } from '../mcp-tool-builder.ts'
import { createBridgeHost, type ElicitResponse, type SampleResponse } from '../bridge-runtime.ts'
import type { ElicitId } from '../mcp-tool-types.ts'

// =============================================================================
// INTERNAL TYPES
// =============================================================================

/**
 * Pending elicit - stores the signal for responding.
 */
interface PendingElicit {
  id: string
  elicitRequestId: ElicitId
  signal: Signal<ElicitResponse, void>
}

/**
 * Pending sample - stores the signal for responding.
 */
interface PendingSample {
  id: string
  signal: Signal<SampleResponse, void>
}

/**
 * Internal state for the session.
 */
interface SessionState<TResult> {
  status: ToolSessionStatus
  lsn: number
  pendingElicit: PendingElicit | null
  pendingSample: PendingSample | null
  result: TResult | null
  error: Error | null
  toolCompleted: boolean
}

// =============================================================================
// TOOL SESSION IMPLEMENTATION
// =============================================================================

/**
 * Create an in-memory tool session.
 *
 * This is a resource that:
 * 1. Spawns the tool execution immediately
 * 2. Events are pushed to a queue as they happen
 * 3. `events()` returns a Stream that pulls from the queue
 * 4. For samples/elicits, the consumer responds and continues iterating
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
  _samplingProvider: ToolSessionSamplingProvider,
  options: ToolSessionOptions = {}
): Operation<ToolSession<TResult>> {
  return resource<ToolSession<TResult>>(function* (provide) {
    const sessionId = options.sessionId ?? generateSessionId()

    // Session state
    const state: SessionState<TResult> = {
      status: 'initializing',
      lsn: 0,
      pendingElicit: null,
      pendingSample: null,
      result: null,
      error: null,
      toolCompleted: false,
    }

    // Queue for events - producer (tool execution) pushes, consumer pulls
    // createQueue returns a synchronous queue with add/close/next methods
    const eventQueue = createQueue<ToolSessionEvent<TResult>, void>()

    // Create the bridge host
    const hostConfig = {
      tool,
      params,
      callId: sessionId,
      ...(options.signal !== undefined && { signal: options.signal }),
      ...(options.parentMessages !== undefined && { parentMessages: options.parentMessages }),
      ...(options.systemPrompt !== undefined && { systemPrompt: options.systemPrompt }),
    }
    const host = createBridgeHost(hostConfig)

    // Helper to create a full event with LSN and timestamp
    function createEvent(event: Omit<ToolSessionEvent<TResult>, 'lsn' | 'timestamp'>): ToolSessionEvent<TResult> {
      return {
        ...event,
        lsn: ++state.lsn,
        timestamp: Date.now(),
      } as ToolSessionEvent<TResult>
    }

    // Start tool execution immediately - this runs in the session's scope
    state.status = 'running'

    // Spawn event processor - converts bridge events to session events
    yield* spawn(function* () {
      for (const event of yield* each(host.events)) {
        switch (event.type) {
          case 'elicit': {
            const elicitId = `${sessionId}:elicit:${state.lsn}`
            state.status = 'awaiting_elicit'
            state.pendingElicit = {
              id: elicitId,
              elicitRequestId: event.request.id,
              signal: event.responseSignal,
            }

            eventQueue.add(createEvent({
              type: 'elicit_request',
              elicitId,
              key: event.request.key,
              message: event.request.message,
              schema: event.request.schema.json,
            } as Omit<ElicitRequestEvent, 'lsn' | 'timestamp'>))
            break
          }

          case 'sample': {
            const sampleId = `${sessionId}:sample:${state.lsn}`
            state.status = 'awaiting_sample'
            state.pendingSample = { id: sampleId, signal: event.responseSignal }

            eventQueue.add(createEvent({
              type: 'sample_request',
              sampleId,
              messages: event.messages,
              systemPrompt: event.options?.systemPrompt,
              maxTokens: event.options?.maxTokens,
              tools: event.options?.tools,
              toolChoice: event.options?.toolChoice,
              schema: event.options?.schema,
            } as Omit<SampleRequestEvent, 'lsn' | 'timestamp'>))
            break
          }

          case 'log':
            eventQueue.add(createEvent({
              type: 'log',
              level: event.level,
              message: event.message,
            } as Omit<LogEvent, 'lsn' | 'timestamp'>))
            break

          case 'notify':
            eventQueue.add(createEvent({
              type: 'progress',
              message: event.message,
              progress: event.progress,
            } as Omit<ProgressEvent, 'lsn' | 'timestamp'>))
            break
        }
        yield* each.next()
      }
    })

    // Spawn tool runner
    yield* spawn(function* () {
      try {
        const result = yield* host.run()
        state.status = 'completed'
        state.result = result
        state.toolCompleted = true

        eventQueue.add(createEvent({
          type: 'result',
          result,
        } as Omit<ResultEvent<TResult>, 'lsn' | 'timestamp'>))
        
        // Close the queue when tool completes
        eventQueue.close()
      } catch (error) {
        state.status = 'failed'
        state.error = error as Error
        state.toolCompleted = true

        eventQueue.add(createEvent({
          type: 'error',
          name: (error as Error).name,
          message: (error as Error).message,
          stack: (error as Error).stack,
        } as Omit<ErrorEvent, 'lsn' | 'timestamp'>))
        
        eventQueue.close()
      }
    })

    // Give spawned tasks a chance to start and produce initial events
    yield* sleep(0)

    // Create the session interface
    const session: ToolSession<TResult> = {
      id: sessionId,
      toolName: tool.name,

      *status(): Operation<ToolSessionStatus> {
        return state.status
      },

      // events() returns a Stream that pulls from the queue
      // Each call to next() blocks until an event is available
      events(_afterLSN?: number): Stream<ToolSessionEvent<TResult>, void> {
        return resource<Subscription<ToolSessionEvent<TResult>, void>>(function* (provide) {
          yield* provide({
            *next(): Operation<IteratorResult<ToolSessionEvent<TResult>, void>> {
              // Pull next event from queue - this blocks until available
              return yield* eventQueue.next()
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
          throw new Error(`Elicitation ID mismatch: expected ${pending.id}, got ${elicitId}`)
        }

        // Send response via the bridge's signal - this unblocks the tool execution
        state.pendingElicit = null
        state.status = 'running'
        pending.signal.send({ id: pending.elicitRequestId, result: response })
        // Yield multiple times to let the tool execution process the response
        // This is a workaround for cross-scope signal delivery
        yield* sleep(0)
        yield* sleep(0)
        yield* sleep(0)
      },

      *respondToSample(sampleId: string, response: SampleResult): Operation<void> {
        const pending = state.pendingSample
        if (!pending) {
          return
        }
        if (pending.id !== sampleId) {
          throw new Error(`Sample ID mismatch: expected ${pending.id}, got ${sampleId}`)
        }

        // Send response via the bridge's signal
        state.pendingSample = null
        state.status = 'running'
        pending.signal.send({ result: response })
        // Yield to let the tool execution process the response and add next event
        yield* sleep(0)
      },

      *emitWakeUp(): Operation<void> {
        // No longer needed
      },

      *cancel(reason?: string): Operation<void> {
        if (state.status === 'completed' || state.status === 'failed' || state.status === 'cancelled') {
          return
        }

        state.status = 'cancelled'
        state.toolCompleted = true

        eventQueue.add(createEvent({
          type: 'cancelled',
          reason,
        } as Omit<CancelledEvent, 'lsn' | 'timestamp'>))
        
        eventQueue.close()
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
