/**
 * useElicitExecutor.ts
 *
 * Automatically executes plugin elicitation handlers when elicit patches arrive.
 * Routes handler emissions through the same state as isomorphic tools (toolEmissions).
 *
 * ## How It Works
 *
 * 1. Watches `pendingElicits` for new pending elicitations
 * 2. Looks up the plugin by `toolName` in the registry
 * 3. Executes the handler (which uses `ctx.render()`)
 * 4. Handler emissions are forwarded as `tool_emission` patches
 * 5. When handler completes, sends `elicit_response` automatically
 */
import { useEffect, useRef } from 'react'
import type { ComponentType } from 'react'
import { run, createSignal } from 'effection'
import type { Task, Operation } from 'effection'
import type { PluginRegistry } from '../../lib/chat/mcp-tools/plugin-registry.ts'
import type { ElicitTrackingState } from '../../lib/chat/state/chat-state.ts'
import type { ElicitState } from '../../lib/chat/patches/elicit.ts'
import type { EmissionPatch } from '../../lib/chat/patches/emission.ts'
import { executeElicitHandlerFromRequest } from '../../lib/chat/mcp-tools/plugin-executor.ts'
import type { PluginClientContext } from '../../lib/chat/mcp-tools/plugin.ts'
import type { ElicitRequest, ElicitId } from '../../lib/chat/mcp-tools/mcp-tool-types.ts'
import { MODEL_CONTEXT_SCHEMA_KEY } from '../../lib/chat/mcp-tools/model-context.ts'

// =============================================================================
// TYPES
// =============================================================================

export interface UseElicitExecutorOptions {
  /** Current pending elicitations from state */
  pendingElicits: ElicitTrackingState[]

  /** Registry of plugin client registrations */
  registry: PluginRegistry

  /** Dispatch an emission patch to add emission to state */
  dispatchEmissionPatch: (patch: EmissionPatch) => void

  /** Send elicit response back to server */
  respondToElicit: (
    elicit: { sessionId: string; callId: string; elicitId: string },
    result: { action: 'accept' | 'decline' | 'cancel'; content?: unknown }
  ) => void
}

// =============================================================================
// HOOK
// =============================================================================

/**
 * Hook that automatically executes plugin handlers when elicitations arrive.
 *
 * This bridges the gap between server-side plugin tools and client-side rendering:
 * - Server emits `elicit` when tool calls `ctx.elicit()`
 * - This hook runs the plugin's handler which uses `ctx.render()`
 * - Handler emissions are routed to `toolEmissions` state
 * - UI renders emissions with `onRespond` wired up automatically
 * - When handler completes, response is sent back to server
 */
export function useElicitExecutor(options: UseElicitExecutorOptions): void {
  const { pendingElicits, registry, dispatchEmissionPatch, respondToElicit } = options

  // Track which elicitations we've already started executing
  const executingRef = useRef<Set<string>>(new Set())

  // Track running tasks so we can clean up
  const tasksRef = useRef<Map<string, Task<void>>>(new Map())

  useEffect(() => {
    // Find pending elicitations that we haven't started executing yet
    for (const tracking of pendingElicits) {
      for (const elicit of tracking.elicitations) {
        // Skip if not pending or already executing
        if (elicit.status !== 'pending') continue
        if (executingRef.current.has(elicit.elicitId)) continue

        // Look up the plugin
        const plugin = registry.get(elicit.toolName)
        if (!plugin) {
          console.warn(
            `No plugin registered for tool "${elicit.toolName}". ` +
            `Register it via the plugins option in useChat/useChatSession.`
          )
          continue
        }

        // Check if the plugin has a handler for this key
        if (!(elicit.key in plugin.handlers)) {
          console.warn(
            `Plugin "${elicit.toolName}" has no handler for key "${elicit.key}". ` +
            `Available keys: ${Object.keys(plugin.handlers).join(', ')}`
          )
          continue
        }

        // Mark as executing
        executingRef.current.add(elicit.elicitId)

        // Start the handler execution
        const task = run(function* () {
          yield* executePluginHandler(
            plugin,
            elicit,
            dispatchEmissionPatch,
            respondToElicit
          )
        })

        tasksRef.current.set(elicit.elicitId, task)

        // Clean up when task completes
        task.then(() => {
          tasksRef.current.delete(elicit.elicitId)
          executingRef.current.delete(elicit.elicitId)
        }).catch((err) => {
          if (err.message !== 'halted') {
            console.error(`Plugin handler error for ${elicit.toolName}.${elicit.key}:`, err)
          }
          tasksRef.current.delete(elicit.elicitId)
          executingRef.current.delete(elicit.elicitId)
        })
      }
    }
  }, [pendingElicits, registry, dispatchEmissionPatch, respondToElicit])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      for (const task of tasksRef.current.values()) {
        task.halt().catch(() => {})
      }
      tasksRef.current.clear()
      executingRef.current.clear()
    }
  }, [])
}

// =============================================================================
// HANDLER EXECUTION
// =============================================================================

/**
 * Execute a single plugin handler for an elicitation.
 */
function* executePluginHandler(
  plugin: ReturnType<PluginRegistry['get']>,
  elicit: ElicitState,
  dispatchEmissionPatch: (patch: EmissionPatch) => void,
  respondToElicit: UseElicitExecutorOptions['respondToElicit']
) {
  if (!plugin) return

  // Emit tool_emission_start patch so UI knows emissions are coming
  dispatchEmissionPatch({
    type: 'tool_emission_start',
    callId: elicit.callId,
    toolName: elicit.toolName,
  })

  // Emission counter for this handler
  let emissionCounter = 0

  // Create a custom render function that dispatches directly to React
  function* renderEmission<TResponse>(
    componentKey: string,
    Component: ComponentType<any>,
    props: Record<string, unknown>
  ): Operation<TResponse> {
    emissionCounter++
    const emissionId = `${elicit.elicitId}-em-${emissionCounter}`

    // Create a signal to wait for the response
    const responseSignal = createSignal<TResponse, void>()

    // Create respond callback that resumes the generator
    const respond = (value: TResponse): void => {
      responseSignal.send(value)
    }

    // Dispatch the emission with the respond callback
    // Include toolName in case tool_emission_start hasn't been processed yet (React batching)
    dispatchEmissionPatch({
      type: 'tool_emission',
      callId: elicit.callId,
      toolName: elicit.toolName,
      emission: {
        id: emissionId,
        type: 'component',
        payload: {
          componentKey,
          props,
          _component: Component,
        },
        timestamp: Date.now(),
        status: 'pending',
      },
      respond: respond as (response: unknown) => void,
    })

    // Wait for the response
    const subscription = yield* responseSignal
    const result = yield* subscription.next()
    return result.value as TResponse
  }

  // Build the elicit request with context embedded in schema
  // Handlers use getElicitContext(req) which extracts from schema.json['x-model-context']
  const schemaWithContext = elicit.context
    ? { ...((elicit.schema as Record<string, unknown>) ?? {}), [MODEL_CONTEXT_SCHEMA_KEY]: elicit.context }
    : (elicit.schema as Record<string, unknown>) ?? {}

  const elicitId: ElicitId = {
    toolName: elicit.toolName,
    key: elicit.key,
    callId: elicit.callId,
    seq: 0,
  }

  const elicitRequest: ElicitRequest<string, any> = {
    id: elicitId,
    key: elicit.key,
    toolName: elicit.toolName,
    callId: elicit.callId,
    seq: 0,
    message: elicit.message,
    schema: {
      zod: {} as any, // Not used by handlers, they use getElicitContext
      json: schemaWithContext,
    },
  }

  // Create a custom plugin client context with our direct render function
  const ctx: PluginClientContext = {
    callId: elicit.callId,
    signal: new AbortController().signal,
    elicitRequest,

    // Custom render that dispatches directly to React state
    *render(Component, props) {
      const componentKey = Component.displayName || Component.name || 'Anonymous'
      return yield* renderEmission(componentKey, Component, props as Record<string, unknown>)
    },

    // Optional reportProgress - no-op
    *reportProgress(_message: string) {
      // No-op for now
    },
  }

  try {
    // Execute the handler
    const result = yield* executeElicitHandlerFromRequest(plugin, elicitRequest, ctx)

    // Handler completed - send the response back to server
    respondToElicit(
      {
        sessionId: elicit.sessionId,
        callId: elicit.callId,
        elicitId: elicit.elicitId,
      },
      result
    )

    // Emit completion patch
    dispatchEmissionPatch({
      type: 'tool_emission_complete',
      callId: elicit.callId,
    })
  } catch (err) {
    // On error, send cancel response
    respondToElicit(
      {
        sessionId: elicit.sessionId,
        callId: elicit.callId,
        elicitId: elicit.elicitId,
      },
      { action: 'cancel' }
    )

    // Re-throw for logging
    throw err
  }
}
