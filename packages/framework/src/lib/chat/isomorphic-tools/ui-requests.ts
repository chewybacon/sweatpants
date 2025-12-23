/**
 * UI Requests - Platform-Agnostic Client Handoff Primitives
 *
 * This module provides a `ctx.waitFor()` primitive that allows client-side
 * tool generators to suspend and wait for UI input without knowing about
 * the specific UI framework (React, terminal, etc.).
 *
 * ## How It Works
 *
 * 1. Tool's client generator calls `yield* ctx.waitFor('request-type', payload)`
 * 2. Framework suspends the generator and emits a `PendingUIRequest`
 * 3. Platform handler (React component, terminal prompt, etc.) renders UI
 * 4. User interacts, handler calls `respond(output)`
 * 5. Generator resumes with the response
 *
 * ## Example Tool
 *
 * ```typescript
 * const tool = defineIsomorphicTool({
 *   name: 'select_choice',
 *   // ...
 *   *client(data, ctx) {
 *     const response = yield* ctx.waitFor('select-choice', {
 *       choices: data.choices,
 *       prompt: data.prompt,
 *     })
 *     return { selected: response.selectedChoice }
 *   }
 * })
 * ```
 *
 * ## Example React Handler
 *
 * ```tsx
 * const handlers = createUIHandlers()
 *   .add('select-choice', (payload, respond) => (
 *     <CardPicker
 *       choices={payload.choices}
 *       onPick={(choice) => respond({ selectedChoice: choice })}
 *     />
 *   ))
 *
 * // In component:
 * {handlers.render(pendingUIRequests)}
 * ```
 */
import type { Operation, Channel, Signal } from 'effection'
import { createSignal, createChannel } from 'effection'
import type { ReactNode } from 'react'

// =============================================================================
// CORE TYPES
// =============================================================================

/**
 * A UI request that the client generator yields to wait for user input.
 */
export interface UIRequest<TPayload = unknown, TResponse = unknown> {
  /** Unique ID for this request */
  id: string
  /** The tool call ID this request is associated with */
  callId: string
  /** Type tag for routing to handlers (e.g., 'select-choice', 'yes-no') */
  type: string
  /** Data the UI needs to render */
  payload: TPayload
  /** Phantom type for response - not used at runtime */
  _responseType?: TResponse
}

/**
 * A pending UI request exposed to the platform layer (React, terminal, etc.).
 */
export interface PendingUIRequest<TPayload = unknown, TResponse = unknown> {
  /** The request details */
  request: UIRequest<TPayload, TResponse>
  /** Call this to provide the response and resume the generator */
  respond: (response: TResponse) => void
}

/**
 * Extended client context with waitFor capability.
 */
export interface WaitForContext {
  /**
   * Yield control to wait for UI input.
   *
   * The generator suspends until a platform handler provides a response.
   *
   * @param type - Type tag for routing (e.g., 'select-choice', 'yes-no')
   * @param payload - Data the UI needs to render
   * @returns The response from the UI handler
   *
   * @example
   * ```typescript
   * const response = yield* ctx.waitFor('select-choice', {
   *   choices: ['A', 'B', 'C'],
   *   prompt: 'Pick one',
   * })
   * // response is typed based on handler registration
   * ```
   */
  waitFor<TPayload, TResponse>(
    type: string,
    payload: TPayload
  ): Operation<TResponse>
}

// =============================================================================
// CLIENT CONTEXT FACTORY
// =============================================================================

/**
 * Creates a client context with waitFor capability.
 *
 * @param callId - The tool call ID (for request association)
 * @param requestChannel - Channel to emit pending UI requests
 * @returns A context object with the waitFor method
 */
export function createWaitForContext(
  callId: string,
  requestChannel: Channel<PendingUIRequest<any, any>, void>
): WaitForContext {
  let requestId = 0

  return {
    *waitFor<TPayload, TResponse>(
      type: string,
      payload: TPayload
    ): Operation<TResponse> {
      const id = `${callId}-ui-${++requestId}`

      // Create a signal for the response
      const responseSignal = createSignal<TResponse, void>()

      // IMPORTANT: Subscribe to the signal BEFORE sending to the channel
      // This prevents the race condition where the handler responds before we're listening
      const subscription = yield* responseSignal

      // Create the pending request
      const pending: PendingUIRequest<TPayload, TResponse> = {
        request: { id, callId, type, payload },
        respond: (response) => responseSignal.send(response),
      }

      // Emit to channel for platform layer to pick up
      yield* requestChannel.send(pending)

      // Now wait for the response
      const { value } = yield* subscription.next()
      return value as TResponse
    },
  }
}

// =============================================================================
// UI REQUEST CHANNEL FACTORY
// =============================================================================

/**
 * Creates a channel for UI requests.
 *
 * This channel bridges the Effection runtime (where tools execute) to the
 * React layer (where UI is rendered).
 */
export function createUIRequestChannel(): Channel<PendingUIRequest, void> {
  return createChannel<PendingUIRequest, void>()
}

// =============================================================================
// UI HANDLER REGISTRY
// =============================================================================

/**
 * A handler function that renders UI for a specific request type.
 */
export type UIHandler<TPayload = unknown, TResponse = unknown> = (
  payload: TPayload,
  respond: (response: TResponse) => void
) => ReactNode

/**
 * Registry of UI handlers for different request types.
 */
export interface UIHandlerRegistry {
  /**
   * Render all pending UI requests that have handlers.
   */
  render(requests: PendingUIRequest[]): ReactNode[]

  /**
   * Render a single UI request if we have a handler for it.
   */
  renderOne(request: PendingUIRequest): ReactNode | null

  /**
   * Check if a handler is registered for a request type.
   */
  has(type: string): boolean

  /**
   * Get all registered request types.
   */
  types(): string[]
}

/**
 * Builder for creating a UI handler registry.
 */
export interface UIHandlerBuilder {
  /**
   * Add a handler for a request type.
   *
   * @param type - The request type to handle
   * @param handler - Function that receives payload and respond callback
   */
  add<TPayload, TResponse>(
    type: string,
    handler: UIHandler<TPayload, TResponse>
  ): UIHandlerBuilder

  /**
   * Build the handler registry.
   */
  build(): UIHandlerRegistry
}

/**
 * Create a UI handler registry using the builder pattern.
 *
 * @example
 * ```tsx
 * const handlers = createUIHandlers()
 *   .add('select-choice', (payload, respond) => (
 *     <CardPicker
 *       choices={payload.choices}
 *       onPick={(c) => respond({ selectedChoice: c })}
 *     />
 *   ))
 *   .add('yes-no', (payload, respond) => (
 *     <YesNoDialog
 *       question={payload.question}
 *       onYes={() => respond({ answer: true })}
 *       onNo={() => respond({ answer: false })}
 *     />
 *   ))
 *   .build()
 * ```
 */
export function createUIHandlers(): UIHandlerBuilder {
  const handlers = new Map<string, UIHandler<any, any>>()

  const builder: UIHandlerBuilder = {
    add<TPayload, TResponse>(
      type: string,
      handler: UIHandler<TPayload, TResponse>
    ) {
      if (handlers.has(type)) {
        throw new Error(`Duplicate UI handler for type: "${type}"`)
      }
      handlers.set(type, handler as UIHandler<any, any>)
      return builder
    },

    build(): UIHandlerRegistry {
      return {
        render(requests) {
          return requests
            .map((req) => this.renderOne(req))
            .filter((node): node is ReactNode => node !== null)
        },

        renderOne(request) {
          const handler = handlers.get(request.request.type)
          if (!handler) return null

          return handler(request.request.payload, request.respond)
        },

        has(type) {
          return handlers.has(type)
        },

        types() {
          return Array.from(handlers.keys())
        },
      }
    },
  }

  return builder
}

// =============================================================================
// SIGNAL FOR UI RESPONSES
// =============================================================================

/**
 * Value sent through the UI response signal.
 */
export interface UIResponseValue {
  /** The request ID */
  requestId: string
  /** The tool call ID */
  callId: string
  /** The response payload */
  response: unknown
}

/**
 * Creates a signal for UI responses.
 *
 * This signal is used to send responses from React back to the Effection runtime.
 */
export function createUIResponseSignal(): Signal<UIResponseValue, void> {
  return createSignal<UIResponseValue, void>()
}
