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
import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { run, each, createSignal } from 'effection'
import {
  createChatSession,
  type ChatSession,
  type ClientToolSessionOptions,
} from '../../lib/chat/session/index.ts'
import { initialChatState } from '../../lib/chat/state/index.ts'
import type { TextPart, ReasoningPart } from '../../lib/chat/types/chat-message.ts'
import { createPipelineTransform, markdown } from './pipeline/index.ts'
import type { ChatState, PendingClientToolState, PendingHandoffState, ToolEmissionTrackingState, ToolEmissionState, SessionOptions } from './types.ts'
import type { PluginElicitTrackingState } from '../../lib/chat/state/chat-state.ts'
import type { PendingHandoff, ToolHandlerRegistry } from '../../lib/chat/isomorphic-tools/index.ts'
import { useChatConfig } from './ChatProvider.tsx'
import { createPluginRegistryFrom } from '../../lib/chat/mcp-tools/plugin-registry.ts'
import type { PluginClientRegistrationInput } from '../../lib/chat/mcp-tools/plugin.ts'
import { usePluginExecutor } from './usePluginExecutor.ts'
import type { EmissionPatch } from '../../lib/chat/patches/emission.ts'

// =============================================================================
// LOCAL EMISSION STATE REDUCER
// =============================================================================

type LocalEmissionState = Record<string, ToolEmissionTrackingState>

type LocalEmissionAction = EmissionPatch & { respond?: (response: unknown) => void }

function localEmissionReducer(
  state: LocalEmissionState,
  action: LocalEmissionAction
): LocalEmissionState {
  switch (action.type) {
    case 'tool_emission_start': {
      return {
        ...state,
        [action.callId]: {
          callId: action.callId,
          toolName: action.toolName,
          emissions: [],
          status: 'running',
          startedAt: Date.now(),
        },
      }
    }
    case 'tool_emission': {
      let tracking = state[action.callId]

      // Auto-create tracking if tool_emission_start hasn't been processed yet
      // This handles React batching race conditions where emissions arrive
      // before the start event is reflected in state
      if (!tracking) {
        tracking = {
          callId: action.callId,
          toolName: action.toolName ?? 'unknown',
          emissions: [],
          status: 'running' as const,
          startedAt: Date.now(),
        }
      }

      const newEmission: ToolEmissionState = {
        callId: action.callId,
        toolName: tracking.toolName,
        id: action.emission.id,
        type: action.emission.type,
        payload: action.emission.payload,
        status: action.emission.status,
        timestamp: action.emission.timestamp,
        ...(action.emission.response !== undefined && { response: action.emission.response }),
        ...(action.emission.error !== undefined && { error: action.emission.error }),
        ...(action.respond !== undefined && { respond: action.respond }),
      }

      return {
        ...state,
        [action.callId]: {
          ...tracking,
          emissions: [...tracking.emissions, newEmission],
        },
      }
    }
    case 'tool_emission_response': {
      const tracking = state[action.callId]
      if (!tracking) return state

      return {
        ...state,
        [action.callId]: {
          ...tracking,
          emissions: tracking.emissions.map(e => {
            if (e.id !== action.emissionId) return e
            // Create new emission without respond callback
            const { respond: _, ...rest } = e
            return { ...rest, status: 'complete' as const, response: action.response }
          }),
        },
      }
    }
    case 'tool_emission_complete': {
      const tracking = state[action.callId]
      if (!tracking) return state

      return {
        ...state,
        [action.callId]: {
          ...tracking,
          status: 'complete',
          completedAt: Date.now(),
        },
      }
    }
    default:
      return state
  }
}

/** Default transforms applied to all sessions */
const defaultTransforms = [createPipelineTransform({ processors: [markdown] })]

/**
 * Options for useChatSession hook.
 */
export interface UseChatSessionOptions extends SessionOptions {
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
   *   tools: [guessCardTool],
   *   reactHandlers: toolHandlers,
   * })
   *
   * return <>{toolHandlers.render(pendingHandoffs, respondToHandoff)}</>
   * ```
   */
  reactHandlers?: ToolHandlerRegistry

  /**
   * Plugin client registrations for MCP tool elicitation handling.
   *
   * When a server-side plugin tool calls `ctx.elicit()`, the framework
   * automatically executes the matching plugin handler which uses `ctx.render()`.
   * Handler emissions are routed to `toolEmissions` state and rendered
   * like any other tool emission.
   *
   * @example
   * ```tsx
   * import { bookFlightPlugin } from './tools/book-flight/plugin'
   *
   * const { messages, send } = useChatSession({
   *   plugins: [bookFlightPlugin.client],
   * })
   * // That's it! Plugin emissions render automatically via toolEmissions.
   * ```
   */
  plugins?: PluginClientRegistrationInput[]
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

  // --- Tool Emissions API (ctx.render() pattern) ---

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

  // Local state for plugin emissions (handled React-side, not through session)
  // Using useState with functional updates for better async compatibility
  const [localEmissions, setLocalEmissions] = useState<LocalEmissionState>({})

  const dispatchLocalEmission = useCallback((action: LocalEmissionAction) => {
    setLocalEmissions(prev => localEmissionReducer(prev, action))
  }, [])

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
    ...(options.reactHandlers && { reactHandlers: options.reactHandlers }),
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
    
    // In the parts-based model, collect content from streaming parts
    // Concatenate all text and reasoning parts for partial content
    const partialContent = currentState.streaming.parts
      .filter((p): p is TextPart | ReasoningPart => 
        p.type === 'text' || p.type === 'reasoning'
      )
      .map(p => p.content)
      .join('')
    
    dispatchRef.current?.({ 
      type: 'abort',
      partialContent,
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

  // Merge session tool emissions with local plugin emissions
  const toolEmissions: ToolEmissionTrackingState[] = useMemo(() => {
    const sessionEmissions = Object.values(state.toolEmissions)
    const pluginEmissions = Object.values(localEmissions)
    return [...sessionEmissions, ...pluginEmissions]
  }, [state.toolEmissions, localEmissions])

  // Create state with merged emissions for consumers like deriveMessages
  // This ensures plugin handler emissions are visible alongside session emissions
  const stateWithMergedEmissions: ChatState = useMemo(() => ({
    ...state,
    toolEmissions: {
      ...state.toolEmissions,
      ...localEmissions,
    },
  }), [state, localEmissions])

  // Ref for local emissions (needed in respondToEmission callback)
  const localEmissionsRef = useRef(localEmissions)
  useEffect(() => {
    localEmissionsRef.current = localEmissions
  }, [localEmissions])

  // Respond to a pending emission (checks both session and local emissions)
  const respondToEmission = useCallback((callId: string, emissionId: string, response: unknown) => {
    // First check session emissions
    const sessionTracking = stateRef.current.toolEmissions[callId]
    const sessionEmission = sessionTracking?.emissions.find(e => e.id === emissionId)
    if (sessionEmission?.respond) {
      sessionEmission.respond(response)
      return
    }

    // Then check local emissions (from plugin handlers)
    const localTracking = localEmissionsRef.current[callId]
    const localEmission = localTracking?.emissions.find(e => e.id === emissionId)
    if (localEmission?.respond) {
      localEmission.respond(response)
      // Also update local state to mark as responded
      dispatchLocalEmission({
        type: 'tool_emission_response',
        callId,
        emissionId,
        response,
      })
    }
  }, [])

  // Get plugin elicitations from state (MCP plugin tools)
  const pluginElicitations: PluginElicitTrackingState[] = Object.values(state.pluginElicitations)

  // Respond to a pending plugin elicitation (internal - used by usePluginExecutor)
  // This dispatches a command to the session which stores the response
  // and sends it with the next message.
  const respondToPluginElicit = useCallback((
    elicit: { sessionId: string; callId: string; elicitId: string },
    result: { action: 'accept' | 'decline' | 'cancel'; content?: unknown }
  ) => {
    // Dispatch a plugin_elicit_response command to the session
    // The session stores it and includes it in the next request
    dispatchRef.current?.({
      type: 'plugin_elicit_response',
      sessionId: elicit.sessionId,
      callId: elicit.callId,
      elicitId: elicit.elicitId,
      result,
    })
  }, [])

  // Build plugin registry from options
  const pluginRegistry = useMemo(
    () => createPluginRegistryFrom(options.plugins ?? []),
    [options.plugins]
  )

  // Dispatch emission patches (for plugin executor to forward handler emissions)
  // These go to local React state, not through the session
  const dispatchEmissionPatch = useCallback((patch: EmissionPatch & { respond?: (response: unknown) => void }) => {
    dispatchLocalEmission(patch)
  }, [])

  // Auto-execute plugin handlers when elicitations arrive
  usePluginExecutor({
    pluginElicitations,
    registry: pluginRegistry,
    dispatchEmissionPatch,
    respondToPluginElicit,
  })

  return {
    state: stateWithMergedEmissions,
    send,
    abort,
    reset,
    capabilities: state.capabilities,
    pendingApprovals,
    approve,
    deny,
    pendingHandoffs,
    respondToHandoff,
    toolEmissions,
    respondToEmission,
  }
}
