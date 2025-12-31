/**
 * Emission Primitives
 *
 * The core primitive layer for tool-to-runtime communication.
 * All context DSLs (browser, agent, headless) build on top of this.
 *
 * ## Design Principles
 *
 * 1. **Serializable Core**: Emission payloads are serializable for potential
 *    rehydration. Component references are transient (_component field).
 *
 * 2. **Single Primitive**: All context methods eventually call `emit()`.
 *    This makes the system extensible via custom handlers.
 *
 * 3. **Effection-Native**: Uses signals for response flow, integrates with
 *    structured concurrency for cleanup on cancellation.
 *
 * ## Architecture
 *
 * ```
 * Tool Generator
 *       │
 *       ▼
 * yield* ctx.render(Component, props)
 *       │
 *       ▼
 * ctx.render() calls runtime.emit('__component__', payload)
 *       │
 *       ▼
 * runtime.emit() creates emission, sends to handler, waits for response
 *       │
 *       ▼
 * Handler (React) renders component, user interacts, calls respond()
 *       │
 *       ▼
 * Signal fires, generator resumes with response
 * ```
 */
import type { Operation, Channel } from 'effection'
import { createSignal } from 'effection'
import type { ComponentType } from 'react'

// =============================================================================
// EMISSION TYPES
// =============================================================================

/**
 * An emission from a tool to its runtime environment.
 *
 * This is the primitive that all context DSL methods build on.
 * The payload must be serializable; component references are transient.
 */
export interface Emission<TPayload = unknown, TResponse = unknown> {
  /** Unique ID for this emission */
  id: string

  /** Type discriminator - routes to handler */
  type: string

  /** Serializable payload data */
  payload: TPayload

  /** Timestamp for ordering in trace */
  timestamp: number

  /** Current status */
  status: 'pending' | 'complete' | 'error'

  /** Response value once complete */
  response?: TResponse

  /** Error message if status is 'error' */
  error?: string
}

/**
 * Component emission payload - used by ctx.render().
 *
 * The _component field is transient (not serialized) but available
 * during execution for immediate rendering.
 */
export interface ComponentEmissionPayload<TProps = Record<string, unknown>> {
  /** Serializable key for component (displayName || name) */
  componentKey: string

  /** Component props (without RenderableProps) */
  props: TProps

  /**
   * Transient component reference for immediate rendering.
   * Not serialized - on rehydration, the tool re-runs and provides fresh reference.
   */
  _component?: ComponentType<any>
}

/**
 * A pending emission that needs a response.
 * Used internally by the runtime to track what's waiting.
 */
export interface PendingEmission<TPayload = unknown, TResponse = unknown> {
  emission: Emission<TPayload, TResponse>
  respond: (response: TResponse) => void
}

/**
 * Trace entry for completed tool message.
 * Fully serializable - no component references.
 */
export interface EmissionTraceEntry {
  /** Order in execution sequence */
  order: number

  /** Component key for potential rehydration */
  componentKey: string

  /** Props that were passed */
  props: Record<string, unknown>

  /** Response value */
  response?: unknown

  /** Timestamp */
  timestamp: number
}

/**
 * Tool execution trace - included in completed tool messages.
 */
export interface ToolExecutionTrace {
  /** All emissions in order */
  emissions: EmissionTraceEntry[]

  /** Start timestamp */
  startedAt: number

  /** End timestamp */
  completedAt: number
}

// =============================================================================
// RUNTIME PRIMITIVE
// =============================================================================

/**
 * Handler for an emission type.
 *
 * @param emission - The emission to handle
 * @param respond - Call with response value to resume the generator
 */
export type EmissionHandler<TPayload = unknown, TResponse = unknown> = (
  emission: Emission<TPayload, TResponse>,
  respond: (value: TResponse) => void
) => void | Promise<void>

/**
 * Configuration for creating a runtime.
 */
export interface RuntimeConfig {
  /** Handlers for emission types */
  handlers: Record<string, EmissionHandler<any, any>>

  /** Fallback behavior for unknown emission types */
  fallback?: 'error' | 'warn' | 'ignore'

  /** Optional channel to send emissions through (for React integration) */
  emissionChannel?: Channel<PendingEmission<any, any>, void>
}

/**
 * The primitive runtime interface.
 * All context DSLs use this to emit to the runtime.
 */
export interface RuntimePrimitive {
  /**
   * Emit to the runtime and wait for response.
   *
   * @param type - Emission type (routes to handler)
   * @param payload - Data for the handler
   * @returns Response from the handler
   */
  emit<TPayload, TResponse>(
    type: string,
    payload: TPayload
  ): Operation<TResponse>
}

/**
 * Create a runtime with the given handlers.
 *
 * @param config - Runtime configuration
 * @param callId - Tool call ID (for emission IDs)
 * @returns RuntimePrimitive
 */
export function createRuntime(
  config: RuntimeConfig,
  callId: string
): RuntimePrimitive {
  let emissionCounter = 0

  return {
    *emit<TPayload, TResponse>(
      type: string,
      payload: TPayload
    ): Operation<TResponse> {
      const emission: Emission<TPayload, TResponse> = {
        id: `${callId}-em-${++emissionCounter}`,
        type,
        payload,
        timestamp: Date.now(),
        status: 'pending',
      }

      const handler = config.handlers[type]

      if (!handler) {
        if (config.fallback === 'error') {
          throw new Error(`No handler for emission type: ${type}`)
        }
        if (config.fallback === 'warn') {
          console.warn(`No handler for emission type: ${type}`)
        }
        // 'ignore' or undefined - return undefined
        return undefined as TResponse
      }

      // Create signal for response
      const responseSignal = createSignal<TResponse, void>()
      const subscription = yield* responseSignal

      // Create respond callback
      const respond = (value: TResponse) => {
        emission.response = value
        emission.status = 'complete'
        responseSignal.send(value)
      }

      // If there's a channel, send through it (for React integration)
      if (config.emissionChannel) {
        yield* config.emissionChannel.send({ emission: emission as Emission, respond })
      }

      // Call the handler
      try {
        const result = handler(emission as Emission, respond)
        if (result instanceof Promise) {
          // Don't await - handler may call respond() asynchronously
          result.catch((err) => {
            emission.status = 'error'
            emission.error = err instanceof Error ? err.message : String(err)
            // Throw in the generator
            responseSignal.send(undefined as TResponse)
          })
        }
      } catch (err) {
        emission.status = 'error'
        emission.error = err instanceof Error ? err.message : String(err)
        throw err
      }

      // Wait for response
      const result = yield* subscription.next()
      
      // Check if we got an error
      if (emission.status === 'error') {
        throw new Error(emission.error ?? 'Emission handler failed')
      }
      
      return result.value as TResponse
    },
  }
}

// =============================================================================
// DEFAULT COMPONENT HANDLER
// =============================================================================

/**
 * The default emission type for ctx.render().
 */
export const COMPONENT_EMISSION_TYPE = '__component__'

/**
 * Create the default component handler.
 *
 * This handler is used by the browser runtime to handle ctx.render() emissions.
 * It sends the emission through a channel to React.
 *
 * @param channel - Channel to send pending emissions to React
 * @returns Handler function
 */
export function createComponentHandler(
  channel: Channel<PendingEmission<ComponentEmissionPayload, unknown>, void>
): EmissionHandler<ComponentEmissionPayload, unknown> {
  return (
    emission: Emission<ComponentEmissionPayload, unknown>,
    _respond: (value: unknown) => void
  ) => {
    // Send to React via channel - respond is passed through
    // The channel consumer (React) will call respond when user interacts
    // We don't call respond here - that's the responsibility of the React side
    
    // Note: This is a sync handler that pushes to channel
    // The actual response comes from React calling the respond callback
    void channel.send({ emission, respond: _respond })
  }
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Extract a serializable key from a component.
 */
export function getComponentKey(Component: ComponentType<any>): string {
  return Component.displayName || Component.name || 'Anonymous'
}

/**
 * Create a trace entry from an emission.
 */
export function emissionToTraceEntry(
  emission: Emission<ComponentEmissionPayload>,
  order: number
): EmissionTraceEntry {
  return {
    order,
    componentKey: emission.payload.componentKey,
    props: emission.payload.props as Record<string, unknown>,
    response: emission.response,
    timestamp: emission.timestamp,
  }
}

/**
 * Create a tool execution trace from a list of emissions.
 */
export function createToolTrace(
  emissions: Emission<ComponentEmissionPayload>[],
  startedAt: number,
  completedAt: number
): ToolExecutionTrace {
  return {
    emissions: emissions.map((e, i) => emissionToTraceEntry(e, i)),
    startedAt,
    completedAt,
  }
}
