/**
 * Plugin Session Manager
 *
 * Manages plugin tool sessions for the chat-engine. This enables MCP plugin tools
 * to suspend mid-execution (e.g., for elicitation) and resume across HTTP request
 * boundaries.
 *
 * Key differences from the MCP transport's ToolSessionRegistry:
 * - Sampling is handled server-side using the chat-engine's provider
 * - Sessions are keyed by callId (from LLM's tool_call.id) for correlation
 * - Designed for integration with the chat-engine's state machine
 *
 * ## Architecture
 *
 * ```
 * PluginSessionManager (handler scope - long-lived)
 *   └── ToolSessionRegistry (reused infrastructure)
 *       └── ToolSession (wraps BridgeHost)
 *           └── Tool generator (stays alive across requests)
 * ```
 *
 * ## Usage
 *
 * ```typescript
 * // At handler initialization
 * const sessionManager = yield* createPluginSessionManager({
 *   store: yield* createInMemoryToolSessionStore(),
 *   samplingProvider: { sample: ... },
 * })
 *
 * // In chat-engine executing_tools phase
 * const session = yield* sessionManager.create({
 *   tool: bookFlightTool,
 *   params: { destination: 'NYC' },
 *   callId: toolCall.id,
 *   provider: chatProvider,
 * })
 *
 * // Wait for next event (elicit_request, result, error)
 * const event = yield* session.nextEvent()
 *
 * // In subsequent request with elicit response
 * const session = yield* sessionManager.get(callId)
 * yield* session.respondToElicit(elicitId, result)
 * ```
 *
 * @packageDocumentation
 */
import { type Operation, type Channel, type Subscription, resource, spawn, sleep } from 'effection'
import type { ChatProvider } from '../../lib/chat/providers/types'
import type {
  ToolSession,
  ToolSessionEvent,
  ToolSessionStatus,
  SampleRequestEvent,
  ToolSessionRegistry,
} from '../../lib/chat/mcp-tools/session/types'
// Note: createToolSessionRegistry should be called at server startup, not here
// import { createToolSessionRegistry } from '../../lib/chat/mcp-tools/session/session-registry'
import type { ElicitsMap, ElicitResult } from '../../lib/chat/mcp-tools/mcp-tool-types'
import type { FinalizedMcpToolWithElicits } from '../../lib/chat/mcp-tools/mcp-tool-builder'
import type { ComponentEmissionPayload, PendingEmission } from '../../lib/chat/isomorphic-tools/runtime/emissions'

// =============================================================================
// TYPES
// =============================================================================

/**
 * Status of a plugin session.
 */
export type PluginSessionStatus = ToolSessionStatus | 'aborted'

/**
 * Information about an active plugin session (for inspection).
 */
export interface PluginSessionInfo {
  id: string
  toolName: string
  callId: string
  status: PluginSessionStatus
  createdAt: number
}

/**
 * Events emitted by a plugin session.
 * These are a subset of ToolSessionEvent, filtered for the chat-engine's needs.
 */
export type PluginSessionEvent =
  | {
      type: 'elicit_request'
      elicitId: string
      key: string
      message: string
      schema: Record<string, unknown>
    }
  | {
      type: 'result'
      result: unknown
    }
  | {
      type: 'error'
      name: string
      message: string
    }
  | {
      type: 'cancelled'
      reason?: string | undefined
    }

/**
 * Configuration for creating a plugin session.
 */
export interface CreatePluginSessionConfig {
  /** The MCP tool to execute */
  tool: FinalizedMcpToolWithElicits<string, unknown, unknown, unknown, unknown, ElicitsMap>

  /** Tool parameters */
  params: unknown

  /** Call ID from the LLM's tool_call (used as session ID) */
  callId: string

  /** Chat provider for handling sample requests server-side */
  provider: ChatProvider

  /** Emission channel for plugin UI rendering (optional) */
  emissionChannel?: Channel<PendingEmission<ComponentEmissionPayload, unknown>, void> | undefined

  /** Abort signal for cancellation */
  signal?: AbortSignal
}

/**
 * A plugin session handle.
 * 
 * Wraps a ToolSession with chat-engine-specific functionality:
 * - Server-side sampling handling
 * - Simplified event interface
 */
export interface PluginSession {
  /** Session ID (same as callId) */
  readonly id: string

  /** Tool name */
  readonly toolName: string

  /** Original call ID from LLM */
  readonly callId: string

  /** Get current session status */
  status(): Operation<PluginSessionStatus>

  /**
   * Get the next event from the session.
   * Blocks until an event is available or session completes.
   * Handles sample_request events internally (server-side sampling).
   */
  nextEvent(): Operation<PluginSessionEvent | null>

  /**
   * Respond to an elicitation request.
   * 
   * @param elicitId - The elicit ID from the elicit_request event
   * @param result - The user's response
   */
  respondToElicit(elicitId: string, result: ElicitResult<unknown>): Operation<void>

  /**
   * Abort the session.
   * 
   * @param reason - Optional abort reason
   */
  abort(reason?: string): Operation<void>
}

/**
 * Plugin Session Manager interface.
 */
export interface PluginSessionManager {
  /**
   * Create a new plugin session for a tool execution.
   * 
   * @param config - Session configuration
   * @returns The created session
   */
  create(config: CreatePluginSessionConfig): Operation<PluginSession>

  /**
   * Get an existing session by ID (callId).
   * Returns null if session doesn't exist.
   * 
   * @param sessionId - Session to retrieve
   * @param provider - Chat provider for server-side sampling (required for recovered sessions)
   */
  get(sessionId: string, provider?: ChatProvider): Operation<PluginSession | null>

  /**
   * Abort a session by ID.
   * 
   * @param sessionId - Session to abort
   * @param reason - Optional abort reason
   */
  abort(sessionId: string, reason?: string): Operation<void>

  /**
   * List all active sessions (for debugging/inspection).
   */
  listActive(): Operation<PluginSessionInfo[]>
}

/**
 * Options for creating a PluginSessionManager.
 */
export interface PluginSessionManagerOptions {
  /**
   * The tool session registry to use.
   * 
   * IMPORTANT: This registry must be created in a long-lived scope (at server
   * startup) to persist across HTTP requests. Sessions created by this manager
   * will live in the registry's scope, enabling multi-step elicitation flows.
   * 
   * Example setup at server initialization:
   * ```typescript
   * const { registry } = await run(function* () {
   *   const store = createInMemoryToolSessionStore()
   *   const registry = yield* createToolSessionRegistry(store, { samplingProvider })
   *   return { registry }
   * })
   * ```
   */
  registry: ToolSessionRegistry
}

// =============================================================================
// IMPLEMENTATION
// =============================================================================

/**
 * Create a PluginSessionManager.
 * 
 * The manager wraps a ToolSessionRegistry to provide plugin-specific functionality:
 * - Per-session provider management for server-side sampling
 * - Simplified event interface (hides sample_request handling)
 * - Session recovery across HTTP request boundaries
 * 
 * IMPORTANT: The registry must be created in a long-lived scope at server startup.
 * The manager itself can be created per-request - it just tracks wrappers.
 */
export function createPluginSessionManager(
  options: PluginSessionManagerOptions
): Operation<PluginSessionManager> {
  return resource<PluginSessionManager>(function* (provide) {
    const { registry } = options

    // Track active plugin sessions with their providers
    const pluginSessions = new Map<string, {
      session: PluginSession
      toolSession: ToolSession
      provider: ChatProvider
      info: PluginSessionInfo
    }>()

    /**
     * Create a PluginSession wrapper around a ToolSession.
     * Handles server-side sampling and provides a simplified event interface.
     */
    function createPluginSessionWrapper(
      toolSession: ToolSession,
      callId: string,
      provider: ChatProvider,
      _createdAt: number,
      initialLastLSN: number = 0
    ): PluginSession {
      // Event subscription state - initialized lazily
      let eventSubscription: Subscription<ToolSessionEvent, void> | null = null
      let aborted = false
      let abortReason: string | undefined
      // Track the last LSN we've processed to avoid replaying old events
      let lastProcessedLSN = initialLastLSN

      const pluginSession: PluginSession = {
        id: toolSession.id,
        toolName: toolSession.toolName,
        callId,

        *status(): Operation<PluginSessionStatus> {
          if (aborted) return 'aborted'
          return yield* toolSession.status()
        },

        *nextEvent(): Operation<PluginSessionEvent | null> {
          if (aborted) {
            return { type: 'cancelled', reason: abortReason }
          }

          // Initialize subscription if needed
          // IMPORTANT: Start from lastProcessedLSN to avoid replaying old events
          // This is critical for multi-step elicitation across request boundaries
          if (!eventSubscription) {
            const stream = toolSession.events(lastProcessedLSN)
            // Subscribe to the stream to get a Subscription object
            eventSubscription = yield* stream
          }

          // Get next event
          while (true) {
            const result = yield* eventSubscription.next()

            if (result.done) {
              return null // Session completed
            }

            const event = result.value
            
            // Update lastProcessedLSN to track our position
            lastProcessedLSN = event.lsn

            switch (event.type) {
              case 'elicit_request':
                // Pass through to caller
                return {
                  type: 'elicit_request',
                  elicitId: (event as any).elicitId,
                  key: (event as any).key,
                  message: (event as any).message,
                  schema: (event as any).schema,
                }

              case 'sample_request': {
                // Handle sampling server-side using the provider
                const sampleEvent = event as SampleRequestEvent
                try {
                  // Convert messages to chat format
                  const chatMessages = sampleEvent.messages.map(msg => ({
                    role: msg.role as 'user' | 'assistant' | 'system',
                    content: msg.content,
                  }))

                  // Call the provider
                  const stream = provider.stream(chatMessages, undefined)
                  const subscription = yield* stream

                  // Collect response
                  let fullText = ''
                  let iteration = yield* subscription.next()
                  while (!iteration.done) {
                    if (iteration.value.type === 'text') {
                      fullText += iteration.value.content
                    }
                    iteration = yield* subscription.next()
                  }

                  const chatResult = iteration.value
                  const responseText = chatResult?.text ?? fullText

                  // Send response back to tool session
                  yield* toolSession.respondToSample(sampleEvent.sampleId, {
                    text: responseText,
                  })
                } catch (error) {
                  // Sampling failed - send error response
                  yield* toolSession.respondToSample(sampleEvent.sampleId, {
                    text: `[Sampling error: ${error instanceof Error ? error.message : String(error)}]`,
                  })
                }
                // Continue to next event (don't return sample_request to caller)
                continue
              }

              case 'result':
                return {
                  type: 'result',
                  result: (event as any).result,
                }

              case 'error':
                return {
                  type: 'error',
                  name: (event as any).name,
                  message: (event as any).message,
                }

              case 'cancelled':
                return {
                  type: 'cancelled',
                  reason: (event as any).reason,
                }

              case 'progress':
              case 'log':
              case 'sample_response_queued':
                // These are informational - skip and get next event
                continue

              default:
                // Unknown event type - skip
                continue
            }
          }
        },

        *respondToElicit(elicitId: string, result: ElicitResult<unknown>): Operation<void> {
          yield* toolSession.respondToElicit(elicitId, result)
        },

        *abort(reason?: string): Operation<void> {
          aborted = true
          abortReason = reason
          yield* toolSession.cancel(reason)
        },
      }

      return pluginSession
    }

    const manager: PluginSessionManager = {
      *create(config: CreatePluginSessionConfig): Operation<PluginSession> {
        const { tool, params, callId, provider, signal } = config

        // Create the underlying tool session
        const sessionOptions: { sessionId: string; signal?: AbortSignal } = {
          sessionId: callId, // Use callId as session ID
        }
        if (signal !== undefined) {
          sessionOptions.signal = signal
        }
        const toolSession = yield* registry.create(tool, params, sessionOptions)

        // Create wrapper
        const createdAt = Date.now()
        const pluginSession = createPluginSessionWrapper(
          toolSession,
          callId,
          provider,
          createdAt
        )

        // Track it
        const info: PluginSessionInfo = {
          id: callId,
          toolName: tool.name,
          callId,
          status: 'running',
          createdAt,
        }

        pluginSessions.set(callId, {
          session: pluginSession,
          toolSession,
          provider,
          info,
        })

        // Spawn status updater
        yield* spawn(function* () {
          while (true) {
            const status = yield* pluginSession.status()
            const entry = pluginSessions.get(callId)
            if (entry) {
              entry.info.status = status
            }
            if (
              status === 'completed' ||
              status === 'failed' ||
              status === 'cancelled' ||
              status === 'aborted'
            ) {
              break
            }
            // TODO: Replace polling with event-based status updates.
            // This is a code smell - we should subscribe to session events
            // or use a signal/channel pattern instead of polling.
            yield* sleep(100)
          }
        })

        return pluginSession
      },

      *get(sessionId: string, provider?: ChatProvider): Operation<PluginSession | null> {
        const entry = pluginSessions.get(sessionId)
        if (entry) {
          return entry.session
        }

        // Try to recover from registry (in case of reconnection)
        const toolSession = yield* registry.get(sessionId)
        if (!toolSession) {
          return null
        }

        // We need a provider to recreate the wrapper for server-side sampling
        if (!provider) {
          // Can't recover without provider
          return null
        }

        // Recover the session by creating a new wrapper
        const createdAt = Date.now()
        const pluginSession = createPluginSessionWrapper(
          toolSession,
          sessionId, // callId is the same as sessionId
          provider,
          createdAt
        )

        // Track it
        const info: PluginSessionInfo = {
          id: sessionId,
          toolName: toolSession.toolName,
          callId: sessionId,
          status: 'running', // Will be updated by status poll
          createdAt,
        }

        pluginSessions.set(sessionId, {
          session: pluginSession,
          toolSession,
          provider,
          info,
        })

        // Spawn status updater for recovered session
        yield* spawn(function* () {
          while (true) {
            const status = yield* pluginSession.status()
            const entry = pluginSessions.get(sessionId)
            if (entry) {
              entry.info.status = status
            }
            if (
              status === 'completed' ||
              status === 'failed' ||
              status === 'cancelled' ||
              status === 'aborted'
            ) {
              break
            }
            yield* sleep(100)
          }
        })

        return pluginSession
      },

      *abort(sessionId: string, reason?: string): Operation<void> {
        const entry = pluginSessions.get(sessionId)
        if (entry) {
          yield* entry.session.abort(reason)
          pluginSessions.delete(sessionId)
          yield* registry.release(sessionId)
        }
      },

      *listActive(): Operation<PluginSessionInfo[]> {
        const infos: PluginSessionInfo[] = []
        for (const entry of pluginSessions.values()) {
          // Update status before returning
          entry.info.status = yield* entry.session.status()
          infos.push({ ...entry.info })
        }
        return infos
      },
    }

    yield* provide(manager)
  })
}
