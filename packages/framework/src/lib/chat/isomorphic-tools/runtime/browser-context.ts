/**
 * Browser Context
 *
 * DSL layer for browser-side tool execution.
 * Builds on top of the emission primitive to provide `ctx.render()`.
 *
 * ## Usage
 *
 * ```typescript
 * *client(handoff, ctx) {
 *   // Render component and wait for user response
 *   const { answer } = yield* ctx.render(AskQuestion, {
 *     question: handoff.question,
 *     options: handoff.options,
 *   })
 *
 *   // Component immediately resolves (fire-and-forget pattern)
 *   yield* ctx.render(ThinkingIndicator, { message: "Processing..." })
 *
 *   return { answer }
 * }
 * ```
 *
 * ## Fire-and-Forget Pattern
 *
 * There's no separate "show" method. Components that don't need user input
 * simply call `onRespond()` immediately in useEffect:
 *
 * ```tsx
 * function ThinkingIndicator({ message, onRespond }: ThinkingProps) {
 *   useEffect(() => { onRespond(undefined) }, [])
 *   return <div>{message}</div>
 * }
 * ```
 */
import type { Operation } from 'effection'
import type { ComponentType } from 'react'
import type { BaseToolContext, BrowserToolContext, ApprovalResult, PermissionType } from '../contexts.ts'
import {
  type RuntimePrimitive,
  type ComponentEmissionPayload,
  type Emission,
  COMPONENT_EMISSION_TYPE,
  getComponentKey,
} from './emissions.ts'

// =============================================================================
// RENDERABLE PROPS
// =============================================================================

/**
 * Props that the framework injects into rendered components.
 *
 * Components should accept these props to work with ctx.render():
 * - `onRespond`: Call with the response value when user completes interaction
 * - `disabled`: True if emission is already complete (for replay)
 * - `response`: The response value (for replay/display)
 */
export interface RenderableProps<TResponse> {
  /** Call this when user completes the interaction */
  onRespond: (value: TResponse) => void

  /** True if this emission is already complete (user can't interact) */
  disabled?: boolean

  /** The response value if already complete */
  response?: TResponse
}

/**
 * Helper type to extract the response type from a component's props.
 * If props extend RenderableProps<T>, this extracts T.
 */
export type ExtractResponse<TProps> = TProps extends RenderableProps<infer R> ? R : void

/**
 * Helper type to get the "user props" - props without RenderableProps fields.
 */
export type UserProps<TProps> = Omit<TProps, keyof RenderableProps<unknown>>

// =============================================================================
// BROWSER CONTEXT INTERFACE
// =============================================================================

/**
 * Extended browser context with render() DSL.
 *
 * This is what client generators receive when the tool declares
 * `.context('browser')`.
 */
export interface BrowserRenderContext extends BrowserToolContext {
  /**
   * Render a React component and wait for user response.
   *
   * The component will be rendered in the chat timeline. When the user
   * interacts (e.g., clicks a button), the component calls `onRespond(value)`
   * and this operation resumes with that value.
   *
   * For "fire-and-forget" components (e.g., loading indicators), the component
   * should call `onRespond()` immediately in useEffect.
   *
   * @param Component - React component to render
   * @param props - Props for the component (without RenderableProps)
   * @returns Response from the component
   *
   * @example
   * ```typescript
   * // Wait for user to pick an option
   * const { choice } = yield* ctx.render(OptionPicker, {
   *   options: ['A', 'B', 'C'],
   *   prompt: 'Pick one',
   * })
   *
   * // Fire-and-forget (component resolves immediately)
   * yield* ctx.render(LoadingSpinner, { message: 'Processing...' })
   * ```
   */
  render<TProps, TResponse = ExtractResponse<TProps>>(
    Component: ComponentType<TProps>,
    props: UserProps<TProps>
  ): Operation<TResponse>
}

// =============================================================================
// EXECUTION STATE
// =============================================================================

/**
 * Tracks emissions during tool execution.
 * Converted to trace when tool completes.
 */
export interface ExecutionState {
  callId: string
  toolName: string
  emissions: Emission<ComponentEmissionPayload>[]
  startedAt: number
  status: 'running' | 'complete' | 'error' | 'cancelled'
}

/**
 * Create initial execution state.
 */
export function createExecutionState(callId: string, toolName: string): ExecutionState {
  return {
    callId,
    toolName,
    emissions: [],
    startedAt: Date.now(),
    status: 'running',
  }
}

// =============================================================================
// BROWSER CONTEXT FACTORY
// =============================================================================

/**
 * Options for creating a browser context.
 */
export interface CreateBrowserContextOptions {
  /** Runtime primitive for emissions */
  runtime: RuntimePrimitive

  /** Tool call ID */
  callId: string

  /** Tool name */
  toolName: string

  /** Execution state to track emissions (optional) */
  executionState?: ExecutionState

  /** Base context methods (optional - provides defaults if not given) */
  baseContext?: Partial<BaseToolContext>

  /** Abort signal for cancellation */
  signal?: AbortSignal
}

/**
 * Create a browser context with the render() DSL.
 *
 * @param options - Context options
 * @returns BrowserRenderContext
 */
export function createBrowserContext(
  options: CreateBrowserContextOptions
): BrowserRenderContext {
  const {
    runtime,
    callId,
    toolName,
    executionState = createExecutionState(callId, toolName),
    baseContext,
    signal = new AbortController().signal,
  } = options

  const ctx: BrowserRenderContext = {
    callId,
    signal,

    // --- Approval methods (from base context or defaults) ---

    requestApproval: baseContext?.requestApproval ?? function* (_message: string): Operation<ApprovalResult> {
      return { approved: true }
    },

    requestPermission: baseContext?.requestPermission ?? function* (_type: PermissionType): Operation<ApprovalResult> {
      return { approved: true }
    },

    reportProgress: baseContext?.reportProgress ?? function* (_message: string): Operation<void> {
      // No-op default
    },

    // --- waitFor (standard browser context method) ---

    *waitFor<TPayload, TResponse>(type: string, payload: TPayload): Operation<TResponse> {
      return yield* runtime.emit<TPayload, TResponse>(type, payload)
    },

    // --- render() DSL ---

    *render<TProps, TResponse = ExtractResponse<TProps>>(
      Component: ComponentType<TProps>,
      props: UserProps<TProps>
    ): Operation<TResponse> {
      const componentKey = getComponentKey(Component)

      const payload: ComponentEmissionPayload = {
        componentKey,
        props: props as Record<string, unknown>,
        _component: Component,
      }

      // Emit and wait for response
      const response = yield* runtime.emit<ComponentEmissionPayload, TResponse>(
        COMPONENT_EMISSION_TYPE,
        payload
      )

      // Track in execution state
      // Find the emission that was just created (it has the response now)
      // Note: We can't easily get the emission ID here since emit() only returns the response
      // The emission is tracked via the channel/handler side
      // For now, we create a synthetic emission record for the trace
      const emission: Emission<ComponentEmissionPayload, TResponse> = {
        id: `${callId}-render-${executionState.emissions.length + 1}`,
        type: COMPONENT_EMISSION_TYPE,
        payload,
        timestamp: Date.now(),
        status: 'complete',
        response,
      }
      executionState.emissions.push(emission as Emission<ComponentEmissionPayload>)

      return response
    },
  }

  return ctx
}

// =============================================================================
// HELPER TYPES
// =============================================================================

/**
 * Infer the props type for a component minus RenderableProps.
 */
export type ComponentUserProps<C extends ComponentType<any>> = C extends ComponentType<infer P>
  ? UserProps<P>
  : never

/**
 * Infer the response type for a component.
 */
export type ComponentResponse<C extends ComponentType<any>> = C extends ComponentType<infer P>
  ? ExtractResponse<P>
  : void
