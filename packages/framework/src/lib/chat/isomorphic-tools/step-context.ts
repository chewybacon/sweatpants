/**
 * Step Context - Extensible context for client generators
 *
 * This module defines the step context API that client generators use to:
 * - Emit fire-and-forget steps (progress, status, narration)
 * - Prompt for user input and wait for response
 * - Render React components inline (React platform only)
 *
 * The context is extensible - different platforms can add their own methods:
 * - React: adds `step()` for component rendering with factory pattern
 * - Terminal: could add `readline()`, `print()`
 * - Any platform: the base `emit()` and `prompt()` work everywhere
 *
 * ## Factory Pattern
 *
 * The React step context uses a factory pattern for type-safe component rendering:
 * - Pass the component and props (without RenderableProps)
 * - Framework injects onRespond/disabled/response at render time
 * - Component + props are stored for serialization
 *
 * ## Architecture
 *
 * ```
 * Client Generator
 *       │
 *       ▼
 * yield* ctx.step(YesNoPrompt, { question: "..." })
 *       │
 *       ▼
 * Step (component + props) flows through channel to platform
 *       │
 *       ▼
 * Platform renders: createElement(component, { ...props, onRespond, disabled, response })
 *       │
 *       ▼
 * User clicks button, calls onRespond(value)
 *       │
 *       ▼
 * Signal resumes generator with value
 *       │
 *       ▼
 * Generator continues execution
 * ```
 */
import type { Operation } from 'effection'
import type { ComponentType, ReactElement } from 'react'
import type { BaseToolContext, BrowserToolContext } from './contexts.ts'
import type { ClientToolContext } from './runtime/tool-runtime.ts'

// =============================================================================
// STEP TYPES
// =============================================================================

/**
 * A step emitted by a client generator.
 *
 * Steps are the "messages" that tool execution produces. They flow through
 * a channel to the platform, which renders them and handles responses.
 */
export interface Step<TPayload = unknown, TResponse = unknown> {
  /** Unique ID for this step */
  id: string

  /** Step kind: emit (fire-and-forget) or prompt (waits for response) */
  kind: 'emit' | 'prompt'

  /** Timestamp when step was created */
  timestamp: number

  /** Current status */
  status: 'pending' | 'complete'

  /** For prompts: the response once provided */
  response?: TResponse

  // --- Type-based step (works on any platform) ---

  /** Step type - routes to renderer */
  type?: string

  /** Data for rendering (component props without RenderableProps) */
  payload?: TPayload

  // --- React-specific step (factory pattern) ---

  /**
   * Component to render (stored as unknown to avoid variance issues).
   * At render time, cast to ComponentType<TPayload & RenderableProps<TResponse>>
   */
  component?: unknown

  /** @deprecated Use component + payload instead. Legacy element for backward compat */
  element?: ReactElement
}

/**
 * A pending step that needs a response (for prompts).
 */
export interface PendingStep<TPayload = unknown, TResponse = unknown> {
  step: Step<TPayload, TResponse>
  respond: (response: TResponse) => void
}

/**
 * The execution trail - all steps from a tool execution.
 *
 * This is like a message history for tool execution. It can be:
 * - Rendered inline in the chat stream
 * - Serialized for session persistence
 * - Used for debugging/replay
 */
export interface ExecutionTrail {
  /** Tool call ID */
  callId: string

  /** Tool name */
  toolName: string

  /** All steps in order */
  steps: Step[]

  /** Final result (once complete) */
  result?: unknown

  /** Execution status */
  status: 'running' | 'complete' | 'error' | 'cancelled'

  /** Start timestamp */
  startedAt: number

  /** End timestamp */
  completedAt?: number
}

// =============================================================================
// STEP CONTEXT INTERFACES
// =============================================================================

/**
 * Base step context - works on any platform.
 *
 * This provides the framework-agnostic primitives that any tool can use.
 * Platforms that don't support React can still use emit() and prompt().
 */
export interface BaseStepContext {
  /**
   * Emit a fire-and-forget step (no response needed).
   *
   * Use for: progress indicators, status updates, narration, side effects.
   *
   * @param type - Step type (routes to renderer)
   * @param payload - Data for rendering
   *
   * @example
   * ```typescript
   * yield* ctx.emit('progress', { percent: 50, message: 'Halfway there...' })
   * yield* ctx.emit('narration', { text: 'Thinking hard...', style: 'thinking' })
   * ```
   */
  emit<TPayload>(type: string, payload: TPayload): Operation<void>

  /**
   * Emit a step and wait for user response.
   *
   * Use for: choices, forms, confirmations, any user input.
   *
   * @param type - Step type (routes to handler)
   * @param payload - Data for rendering
   * @returns The response from the handler
   *
   * @example
   * ```typescript
   * const { answer } = yield* ctx.prompt<
   *   { question: string },
   *   { answer: boolean }
   * >('yes-no', { question: 'Is it alive?' })
   * ```
   */
  prompt<TPayload, TResponse>(type: string, payload: TPayload): Operation<TResponse>
}

/**
 * React-enhanced step context.
 *
 * Adds `step()` and `show()` for interactive UI elements using a factory pattern.
 * Only available when running on a React platform.
 */
export interface ReactStepContext extends BaseStepContext {
  /**
   * Render a component inline and wait for user response.
   *
   * This is the primary API for interactive steps. Pass a component and its props
   * (without RenderableProps) - the framework injects onRespond/disabled/response
   * at render time.
   *
   * The component + props are stored for serialization and replay.
   *
   * @param Component - React component that accepts TProps (which extends RenderableProps<TResponse>)
   * @param props - Props for the component (without onRespond/disabled/response)
   * @returns The value passed to onRespond()
   *
   * @example
   * ```tsx
   * // Component definition
   * interface YesNoProps extends RenderableProps<boolean> {
   *   question: string
   * }
   * function YesNoPrompt({ question, onRespond, disabled }: YesNoProps) { ... }
   *
   * // Usage in tool
   * const answer = yield* ctx.step(YesNoPrompt, { question: 'Is it alive?' })
   * // Framework renders: <YesNoPrompt question="..." onRespond={...} disabled={...} />
   * ```
   */
  step<TProps, TResponse = ExtractResponse<TProps>>(
    Component: ComponentType<TProps>,
    props: Omit<TProps, keyof RenderableProps<TResponse>>
  ): Operation<TResponse>

  /**
   * Render a component inline as a fire-and-forget step.
   *
   * Use for components that don't need a response (narration, status, etc.)
   *
   * @param Component - React component to render
   * @param props - Props for the component (can omit RenderableProps fields)
   *
   * @example
   * ```tsx
   * yield* ctx.show(Narration, { text: 'Thinking...', style: 'thinking' })
   * ```
   */
  show<TProps>(
    Component: ComponentType<TProps>,
    props: Omit<TProps, keyof RenderableProps<unknown>>
  ): Operation<void>
}

/**
 * Full client context that includes both:
 * - Base tool context (approval, progress, signal)
 * - Step context methods (emit, prompt, render)
 * - Optional waitFor (available if the underlying context supports it)
 *
 * This is what client generators receive.
 */
export interface ClientStepContext extends BaseToolContext, ReactStepContext {
  /**
   * Optional waitFor - only available if the base context provides it.
   * Use this for browser-specific tools that need UI interaction beyond steps.
   */
  waitFor?<TPayload, TResponse>(
    type: string,
    payload: TPayload
  ): Operation<TResponse>
}

// =============================================================================
// PROPS FOR RENDERABLE COMPONENTS
// =============================================================================

/**
 * Props that the framework injects into rendered components.
 *
 * Components should accept these props to work with ctx.step():
 * - `onRespond`: Call with the response value when user completes interaction
 * - `disabled`: True if step is already complete (for replay)
 * - `response`: The response value (for replay/display)
 */
export interface RenderableProps<TResponse> {
  /** Call this when user completes the interaction */
  onRespond?: (value: TResponse) => void

  /** True if this step is already complete (user can't interact) */
  disabled?: boolean

  /** The response value if already complete */
  response?: TResponse
}

/**
 * Helper type to extract the response type from a component's props.
 * If props extend RenderableProps<T>, this extracts T.
 */
export type ExtractResponse<TProps> = TProps extends RenderableProps<infer R> ? R : never

/**
 * Helper type to get the "user props" - props without RenderableProps fields.
 */
export type UserProps<TProps> = Omit<TProps, keyof RenderableProps<unknown>>

// =============================================================================
// RE-EXPORT FOR CONVENIENCE
// =============================================================================

export type { ClientToolContext }

// =============================================================================
// FACTORY FUNCTION
// =============================================================================

import { createSignal, type Channel } from 'effection'

/**
 * Options for creating a step context.
 */
export interface CreateStepContextOptions {
  /** Tool call ID (used for step IDs) */
  callId: string

  /** Execution trail to record steps into */
  trail: ExecutionTrail

  /** Channel to send pending steps through */
  stepChannel: Channel<PendingStep<unknown, unknown>, void>

  /** Base tool context (for approval, progress, signal). Can be BaseToolContext or BrowserToolContext. */
  baseContext?: BaseToolContext
}

/**
 * Create a ReactStepContext wired up to channels and signals.
 *
 * This is the factory that the executor uses to create the context
 * passed to client generators.
 *
 * @example
 * ```typescript
 * const ctx = createReactStepContext({
 *   callId: 'call-123',
 *   trail,
 *   stepChannel,
 *   baseContext: clientToolContext,
 * })
 *
 * // Now the client generator can use it:
 * function* myClient(params, ctx) {
 *   const answer = yield* ctx.render(<YesNoPrompt question="..." />)
 *   return { answer }
 * }
 * ```
 */
export function createReactStepContext(
  options: CreateStepContextOptions
): ClientStepContext {
  const { callId, trail, stepChannel, baseContext } = options
  let stepCounter = 0

  const ctx: ClientStepContext = {
    // --- Forward base context methods ---
    callId,
    signal: baseContext?.signal ?? new AbortController().signal,

    requestApproval: baseContext?.requestApproval ?? function*() {
      return { approved: true }
    },

    requestPermission: baseContext?.requestPermission ?? function*() {
      return { approved: true }
    },

    reportProgress: baseContext?.reportProgress ?? function*() {
      // No-op if no base context
    },

    // --- Step context methods ---

    *emit<TPayload>(type: string, payload: TPayload) {
      const step: Step<TPayload> = {
        id: `${callId}-step-${++stepCounter}`,
        kind: 'emit',
        type,
        payload,
        timestamp: Date.now(),
        status: 'complete',
      }
      trail.steps.push(step)
      yield* stepChannel.send({ step: step as Step, respond: () => { } })
    },

    *prompt<TPayload, TResponse>(
      type: string,
      payload: TPayload
    ): Operation<TResponse> {
      const step: Step<TPayload, TResponse> = {
        id: `${callId}-step-${++stepCounter}`,
        kind: 'prompt',
        type,
        payload,
        timestamp: Date.now(),
        status: 'pending',
      }
      trail.steps.push(step)

      const responseSignal = createSignal<TResponse, void>()
      const subscription = yield* responseSignal

      yield* stepChannel.send({
        step: step as Step,
        respond: (response: unknown) => {
          step.response = response as TResponse
          step.status = 'complete'
          responseSignal.send(response as TResponse)
        },
      })

      const result = yield* subscription.next()
      // Signal will always send a value before completing
      return result.value as TResponse
    },

    *step<TProps, TResponse = ExtractResponse<TProps>>(
      Component: ComponentType<TProps>,
      props: Omit<TProps, keyof RenderableProps<TResponse>>
    ): Operation<TResponse> {
      // Extract component name for serialization (displayName or function name)
      const componentName = Component.displayName || Component.name || 'Anonymous'

      const step: Step<Omit<TProps, keyof RenderableProps<TResponse>>, TResponse> = {
        id: `${callId}-step-${++stepCounter}`,
        kind: 'prompt',
        type: componentName,
        payload: props,
        component: Component,
        timestamp: Date.now(),
        status: 'pending',
      }
      trail.steps.push(step as Step)

      const responseSignal = createSignal<TResponse, void>()
      const subscription = yield* responseSignal

      yield* stepChannel.send({
        step: step as Step,
        respond: (response: unknown) => {
          step.response = response as TResponse
          step.status = 'complete'
          responseSignal.send(response as TResponse)
        },
      })

      const result = yield* subscription.next()
      return result.value as TResponse
    },

    *show<TProps>(
      Component: ComponentType<TProps>,
      props: Omit<TProps, keyof RenderableProps<unknown>>
    ): Operation<void> {
      // Extract component name for serialization
      const componentName = Component.displayName || Component.name || 'Anonymous'

      const step: Step<Omit<TProps, keyof RenderableProps<unknown>>, void> = {
        id: `${callId}-step-${++stepCounter}`,
        kind: 'emit',
        type: componentName,
        payload: props,
        component: Component,
        timestamp: Date.now(),
        status: 'complete',
      }
      trail.steps.push(step as Step)
      yield* stepChannel.send({ step: step as Step, respond: () => { } })
    },
  }

  // Copy waitFor if the base context provides it (BrowserToolContext)
  const browserCtx = baseContext as BrowserToolContext | undefined
  if (browserCtx?.waitFor) {
    ctx.waitFor = browserCtx.waitFor
  }

  return ctx
}

/**
 * Create an empty execution trail.
 */
export function createExecutionTrail(
  callId: string,
  toolName: string
): ExecutionTrail {
  return {
    callId,
    toolName,
    steps: [],
    status: 'running',
    startedAt: Date.now(),
  }
}
