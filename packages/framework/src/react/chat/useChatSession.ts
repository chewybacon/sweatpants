/**
 * useChatSession.ts
 *
 * React hook that bridges React state <-> Effection session runtime.
 *
 * ## Architecture
 *
 * This hook is a thin adapter around the `createChatSession` resource.
 * It manages:
 * 1. Mounting/unmounting the Effection session
 * 2. Syncing session state to React state
 * 3. Exposing dispatch methods (send, abort, reset)
 */
import { useState, useEffect, useCallback, useRef } from 'react'
import { run, each, createSignal } from 'effection'
import { createChatSession, type ChatSession } from './session'
import type { ClientToolSessionOptions } from './session'
import { createPipelineTransform, markdown } from './pipeline'
import type { ChatState, PendingClientToolState, PendingHandoffState, PendingStepState, ExecutionTrailState, ToolEmissionTrackingState } from './types'
import { initialChatState } from './types'
import type { SessionOptions } from './types'
import type { IsomorphicToolRegistry, PendingHandoff, ToolHandlerRegistry } from '../../lib/chat/isomorphic-tools'
import { useChatConfig } from './ChatProvider'

/** Default transforms applied to all sessions */
const defaultTransforms = [createPipelineTransform({ processors: [markdown] })]

/**
 * Options for useChatSession hook.
 */
export interface UseChatSessionOptions extends SessionOptions {
  /**
   * Isomorphic tools.
   *
   * These tools have both server and client parts. The server executes
   * its part and sends a handoff event. The session then executes the
   * client part and merges the results.
   */
  isomorphicTools?: IsomorphicToolRegistry

  /**
   * Registry of React tool handlers.
   *
   * When a tool has a handler registered here, instead of running its
   * `*client()` generator, the session emits a `pending_handoff` patch
   * and waits for `respondToHandoff()` to receive the response.
   *
   * @example
   * ```tsx
   * const toolHandlers = createToolHandlers()
   *   .add(guessCardTool, (data, respond) => (
   *     <CardPicker choices={data.choices} onPick={respond} />
   *   ))
   *   .build()
   *
   * const { pendingHandoffs, respondToHandoff } = useChatSession({
   *   isomorphicTools: registry,
   *   reactHandlers: toolHandlers,
   * })
   *
   * return <>{toolHandlers.render(pendingHandoffs, respondToHandoff)}</>
   * ```
   */
  reactHandlers?: ToolHandlerRegistry

  /**
   * Enable step context for client tools (ctx.render pattern).
   *
   * When enabled, client tools can use:
   * - ctx.render(<Element />) - Render JSX and wait for response
   * - ctx.show(<Element />) - Render JSX fire-and-forget
   * - ctx.emit(type, payload) - Emit a step fire-and-forget
   * - ctx.prompt(type, payload) - Emit a step and wait for response
   *
   * Pending steps are exposed via `pendingSteps` and can be responded to
   * via `respondToStep(stepId, value)`.
   *
   * @example
   * ```tsx
   * const { pendingSteps, respondToStep } = useChatSession({
   *   enableStepContext: true,
   *   isomorphicTools: registry,
   * })
   *
   * // Render pending steps inline
   * {pendingSteps.map(step => (
   *   <div key={step.stepId}>
   *     {cloneElement(step.element as ReactElement, {
   *       onRespond: (value) => respondToStep(step.stepId, value)
   *     })}
   *   </div>
   * ))}
   * ```
   */
  enableStepContext?: boolean


}

export interface UseChatSessionReturn {
  /** Current session state */
  state: ChatState
  /** Send a message */
  send: (content: string) => void
  /** Abort current streaming */
  abort: () => void
  /** Reset the session */
  reset: () => void
  /** Current session capabilities */
  capabilities: ChatState['capabilities']
  
  // --- Client Tool Approval API ---
  
  /**
   * Pending client tools awaiting approval.
   * 
   * Array of tools that need user approval before execution.
   * Use `approve()` or `deny()` to respond.
   */
  pendingApprovals: PendingClientToolState[]
  
  /**
   * Approve a pending client tool.
   * 
   * @param callId - The tool call ID to approve
   */
  approve: (callId: string) => void
  
  /**
   * Deny a pending client tool.
   * 
   * @param callId - The tool call ID to deny
   * @param reason - Optional reason for denial
   */
  deny: (callId: string, reason?: string) => void

  // --- Tool Handoff API (React Integration) ---

  /**
   * Pending tool handoffs that need UI handling.
   * 
   * Use with `createToolHandlers()` to render type-safe UI:
   * ```tsx
   * const toolHandlers = createToolHandlers()
   *   .add(myTool, (data, respond) => <MyUI data={data} onComplete={respond} />)
   *   .build()
   * 
   * return <>{toolHandlers.render(pendingHandoffs, respondToHandoff)}</>
   * ```
   */
  pendingHandoffs: PendingHandoff[]

  /**
   * Respond to a pending handoff with client output.
   * 
   * @param callId - The tool call ID
   * @param output - The client output (type depends on tool)
   */
  respondToHandoff: (callId: string, output: unknown) => void

  // --- Step Context API (ctx.render pattern) ---

  /**
   * Pending steps from tools using ctx.render() pattern.
   *
   * These are prompt steps that need user input before the tool can continue.
   * The step may contain:
   * - `element`: A React element to render (for ctx.render() calls)
   * - `type` + `payload`: Data for type-based steps (for ctx.prompt() calls)
   *
   * @example
   * ```tsx
   * // Render pending steps inline
   * {pendingSteps.map(step => (
   *   <div key={step.stepId}>
   *     {step.element
   *       ? React.cloneElement(step.element as ReactElement, {
   *           onRespond: (value) => respondToStep(step.stepId, value)
   *         })
   *       : <TypeBasedRenderer type={step.type} payload={step.payload}
   *           onRespond={(value) => respondToStep(step.stepId, value)} />
   *     }
   *   </div>
   * ))}
   * ```
   */
  pendingSteps: PendingStepState[]

  /**
   * Respond to a pending step with user input.
   *
   * Call this when the user completes interaction with a step's UI.
   * This resumes the tool's generator with the response value.
   *
   * @param stepId - The step ID
   * @param response - The response value (type depends on step)
   */
  respondToStep: (stepId: string, response: unknown) => void

  /**
   * Active execution trails for tools using ctx.render() pattern.
   *
   * Use this for displaying all steps (including completed ones) in the chat stream.
   * Each trail contains all steps for a tool call in order.
   */
  executionTrails: ExecutionTrailState[]

  // --- Tool Emissions API (new ctx.render() pattern) ---

  /**
   * Active tool emissions from tools using the new ctx.render() pattern.
   *
   * Each entry tracks all emissions for a tool call including their status.
   * Emissions with `status: 'pending'` need user interaction before the tool can continue.
   *
   * @example
   * ```tsx
   * // Render pending emissions
   * {toolEmissions.map(tracking => (
   *   tracking.emissions.filter(e => e.status === 'pending').map(emission => {
   *     const Component = emission.payload._component
   *     return (
   *       <Component
   *         key={emission.id}
   *         {...emission.payload.props}
   *         onRespond={(value) => respondToEmission(emission.callId, emission.id, value)}
   *         disabled={false}
   *       />
   *     )
   *   })
   * ))}
   * ```
   */
  toolEmissions: ToolEmissionTrackingState[]

  /**
   * Respond to a pending emission with user input.
   *
   * Call this when the user completes interaction with an emission's UI.
   * This resumes the tool's execution with the response value.
   *
   * @param callId - The tool call ID
   * @param emissionId - The emission ID
   * @param response - The response value (type depends on component)
   */
  respondToEmission: (callId: string, emissionId: string, response: unknown) => void
}

/**
 * Hook that provides an Effection-powered chat session.
 *
 * The session runtime runs as a long-lived Effection task.
 * Commands are sent via Signal, state updates come via Channel.
 *
 * @param options - Session configuration options
 */
export function useChatSession(options: UseChatSessionOptions = {}): UseChatSessionReturn {
  const config = useChatConfig()
  const [state, setState] = useState<ChatState>(initialChatState)

  // Ref to access current state in callbacks without re-creating them
  const stateRef = useRef<ChatState>(state)
  useEffect(() => {
    stateRef.current = state
  }, [state])

  // Merge default transforms with user-provided transforms
  // Use baseUrl from options if provided, otherwise from context
  const mergedOptions: ClientToolSessionOptions = {
    ...options,
    baseUrl: options.baseUrl ?? config.baseUrl,
    transforms: options.transforms ?? defaultTransforms,
    ...(options.isomorphicTools && { isomorphicTools: options.isomorphicTools }),
    ...(options.reactHandlers && { reactHandlers: options.reactHandlers }),
    ...(options.enableStepContext !== undefined && { enableStepContext: options.enableStepContext }),
  }

  // Stable ref to options to avoid re-running effect if object identity changes
  const optionsRef = useRef(mergedOptions)
  useEffect(() => {
    optionsRef.current = mergedOptions
  }, [mergedOptions])

  // Store the dispatch function from the session
  const dispatchRef = useRef<ChatSession['dispatch'] | null>(null)
  
  // Store the approval callback function
  const sendApprovalRef = useRef<((value: { callId: string, approved: boolean, reason?: string }) => void) | null>(null)

  // Store the handoff response callback function
  const sendHandoffResponseRef = useRef<((value: { callId: string, output: unknown }) => void) | null>(null)

  useEffect(() => {
    // Start the Effection runtime
    const task = run(function* () {
      // Create approval signal locally so we can bridge it to React callbacks
      // createSignal is now imported directly from 'effection'
      const approvalSignal = createSignal<{ callId: string, approved: boolean, reason?: string }, void>();
      
      sendApprovalRef.current = (val) => approvalSignal.send(val);

      // Create handoff response signal for React tool handlers
      const handoffResponseSignal = createSignal<{ callId: string, output: unknown }, void>();
      
      sendHandoffResponseRef.current = (val) => handoffResponseSignal.send(val);
      
      // Create a session using the resource pattern
      // The resource returns { state, dispatch } and manages the session lifecycle
      const { state: stateStream, dispatch } = yield* createChatSession({
        ...optionsRef.current,
        approvalSignal,
        handoffResponseSignal,
      });
      
      // Expose dispatch to React
      dispatchRef.current = dispatch

      // Subscribe to state updates
      for (const s of yield* each(stateStream)) {
        setState(s)
        yield* each.next()
      }
    })

    // Cleanup: halt the task
    return () => {
      dispatchRef.current = null
      sendApprovalRef.current = null
      sendHandoffResponseRef.current = null
      void task.halt().catch((e) => {
        if (e.message !== 'halted') console.error(e);
      })
    }
  }, [])

  // Stable command callbacks
  const send = useCallback((content: string) => {
    dispatchRef.current?.({ type: 'send', content })
  }, [])

  const abort = useCallback(() => {
    const currentState = stateRef.current
    // Collect partial content from the buffer (settled + pending)
    const partialContent = currentState.buffer.settled + currentState.buffer.pending
    // Use only the settled HTML for display (safe, fully rendered)
    const partialHtml = currentState.buffer.settledHtml
    
    dispatchRef.current?.({ 
      type: 'abort',
      partialContent,
      partialHtml,
    })
  }, [])

  const reset = useCallback(() => {
    dispatchRef.current?.({ type: 'reset' })
  }, [])

  // Client tool approval callbacks
  const approve = useCallback((callId: string) => {
    sendApprovalRef.current?.({ callId, approved: true })
  }, [])

  const deny = useCallback((callId: string, reason?: string) => {
    sendApprovalRef.current?.({ callId, approved: false, ...(reason !== undefined && { reason }) })
  }, [])

  // Tool handoff response callback
  const respondToHandoff = useCallback((callId: string, output: unknown) => {
    sendHandoffResponseRef.current?.({ callId, output })
  }, [])

  // Get pending approvals from state
  const pendingApprovals = Object.values(state.pendingClientTools).filter(
    (tool) => tool.state === 'awaiting_approval'
  )

  // Derive pending handoffs from state
  // Map from PendingHandoffState (internal) to PendingHandoff (external API)
  const pendingHandoffs: PendingHandoff[] = Object.values(state.pendingHandoffs).map(
    (h: PendingHandoffState): PendingHandoff => ({
      callId: h.callId,
      toolName: h.toolName,
      params: h.params,
      data: h.data,
      authority: h.authority,
      usesHandoff: h.usesHandoff,
    })
  )

  // Get pending steps from state (for ctx.render pattern)
  const pendingSteps: PendingStepState[] = Object.values(state.pendingSteps)

  // Respond to a pending step
  const respondToStep = useCallback((stepId: string, response: unknown) => {
    const step = stateRef.current.pendingSteps[stepId]
    if (step?.respond) {
      step.respond(response)
    }
  }, [])

  // Get execution trails from state
  const executionTrails: ExecutionTrailState[] = Object.values(state.executionTrails)

  // Get tool emissions from state (new ctx.render() pattern)
  const toolEmissions: ToolEmissionTrackingState[] = Object.values(state.toolEmissions)

  // Respond to a pending emission
  const respondToEmission = useCallback((callId: string, emissionId: string, response: unknown) => {
    const tracking = stateRef.current.toolEmissions[callId]
    const emission = tracking?.emissions.find(e => e.id === emissionId)
    if (emission?.respond) {
      emission.respond(response)
    }
  }, [])

  return { 
    state, 
    send, 
    abort, 
    reset, 
    capabilities: state.capabilities,
    pendingApprovals,
    approve,
    deny,
    pendingHandoffs,
    respondToHandoff,
    pendingSteps,
    respondToStep,
    executionTrails,
    toolEmissions,
    respondToEmission,
  }
}
